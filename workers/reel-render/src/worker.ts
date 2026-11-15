/**
 * Faceful reel render worker.
 *
 * Polls the Faceful engine for saved timelines to render, draws them with the same Remotion
 * composition the studio previews, and uploads the MP4 back, where it becomes a `render` draft file.
 * Run as many as you like (several VPSs, boxd machines or containers): each job is leased to one
 * worker at a time, and a worker that goes silent loses its lease so another can pick the job up.
 *
 * The worker holds one engine credential, REEL_WORKER_TOKEN, and never sees a database key: it only gets
 * one job at a time with short-lived signed links. Speech keys are optional (voiceovers the engine could not make).
 *
 * Env:
 *   FACEFUL_API_URL         e.g. https://faceful.dtheo.dev (required)
 *   REEL_WORKER_TOKEN       the engine's REEL_WORKER_TOKEN (required, at least 32 characters)
 *   WORKER_ID               defaults to the hostname
 *   POLL_SECONDS            idle wait between claims (default 5)
 *   RENDER_CONCURRENCY      Chrome tabs per render (default: Remotion's choice)
 *   CHROME_EXECUTABLE       optional path to Chrome; Remotion's headless shell is used otherwise
 *   CHROME_MODE             "headless-shell" (default) or "chrome-for-testing" (needed for a desktop Chrome)
 *   SUPABASE_URL            the engine's Supabase project URL: its signed media links come from this host
 *   FACEFUL_R2_ACCOUNT_ID   the engine's R2 account: draft files come from <account>.r2.cloudflarestorage.com
 *   MEDIA_HOST_ALLOWLIST    more exact host names (comma separated) that linked media may come from
 *   WORK_DIR                scratch folder for renders (default: the OS temp folder)
 *   SERVE_PORT              instead of polling, wait on this port for one job handed over by POST /run {workerId, job},
 *                           render it and exit (Cloudflare Containers: workers/reel-render/cloudflare)
 *
 * Voiceover (optional, but a timeline nobody speaks in fails without one rather than rendering silent):
 *   AZURE_SPEECH_KEY + AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT   Microsoft Text to Speech (docs/product/microsoft-tts.md)
 *   AZURE_TTS_VOICE, AZURE_TTS_VOICE_<LANG>                          voice names; defaults: en-US-AvaMultilingualNeural, el-GR-AthinaNeural
 *   ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID, CARTESIA_API_KEY + CARTESIA_VOICE_ID   other stock voices, tried after Azure
 * The engine normally makes the voice when the render is queued; these keys cover jobs that arrive without one.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderMedia, selectComposition } from "@remotion/renderer";
import { allowedMediaUrl, mediaHosts, stageMedia, type StagedMedia } from "./media.ts";
import { defaultVoices, layVoiceover, speakFirst, speaksAlready, voiceKeysFrom, type Timeline } from "../../../packages/engine/src/voice-providers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const API = (env.FACEFUL_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = env.REEL_WORKER_TOKEN ?? "";
/** Set once per job in SERVE_PORT mode, where the job was claimed under the dispatcher's id. */
let WORKER_ID = (env.WORKER_ID ?? hostname()).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 80);
const POLL_MS = Math.max(1, Number(env.POLL_SECONDS ?? 5)) * 1000;
const WORK_DIR = env.WORK_DIR ?? join(tmpdir(), "faceful-reel-worker");
const ONCE = process.argv.includes("--once");
/** Every media file, signed draft-file links included, may only come from these exact hosts (media.ts). */
const MEDIA_HOSTS = mediaHosts(env);
/** Speech services for voiceovers the engine could not make (voice-providers.ts). */
const VOICE_KEYS = voiceKeysFrom(env);
/** Stands in for the voice made here until it is staged next to the other media. */
const GENERATED_VOICE = "generated:voiceover";

if (!/^https?:\/\//.test(API) || TOKEN.length < 32) {
  console.error("Set FACEFUL_API_URL and REEL_WORKER_TOKEN (at least 32 characters).");
  process.exit(2);
}

type Media = { url: string; mime: string };
type Job = {
  id: string;
  campaignId: string;
  itemId: string;
  compositionRevision: number;
  attempt: number;
  leaseSeconds: number;
  composition: { fps: number; durationSeconds: number; video: Array<{ source: { kind: string; url?: string } }>; audio: Array<{ source: { kind: string; url?: string } }> } & Record<string, unknown>;
  itemMedia: Media | null;
  files: Record<string, Media>;
  /** What to read aloud, when the timeline has no voice yet. Engines from before voiceovers leave it out. */
  narration?: { text: string; language: string } | null;
};

const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), worker: WORKER_ID, event, ...fields }));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

class Gone extends Error {}
async function call<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API}/v1/worker/reel${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  // 404/409: the job was cancelled, reassigned or finished elsewhere. Stop working on it.
  if (response.status === 404 || response.status === 409) throw new Gone(payload.error?.message ?? "The job is no longer ours.");
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${payload.error?.message ?? "no details"}`);
  return payload as T;
}

let serveUrl: string | null = null;
async function bundled() {
  if (serveUrl) return serveUrl;
  const started = Date.now();
  // One React and one Remotion for the whole bundle, even though the component lives in the web app.
  const local = (name: string) => dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`)));
  serveUrl = await bundle({
    entryPoint: join(here, "entry.tsx"),
    webpackOverride: (config) => ({
      ...config,
      resolve: { ...config.resolve, alias: { ...(config.resolve?.alias as Record<string, string>), remotion: local("remotion"), react: local("react"), "react-dom": local("react-dom") } },
    }),
  });
  log("bundled", { ms: Date.now() - started });
  return serveUrl;
}

/**
 * A timeline nobody speaks in gets the script read aloud. The engine says what to read; an older engine says nothing,
 * and then the captions are read (in Greek when they are written in Greek).
 */
async function voiceover(job: Job): Promise<{ composition: Job["composition"]; bytes: Uint8Array } | null> {
  const timeline = job.composition as unknown as Timeline;
  if (speaksAlready(timeline, Boolean(job.itemMedia))) return null;
  const captions = timeline.captions.map((cue) => cue.text).join(" ").trim();
  const said = job.narration === undefined ? (captions ? { text: captions, language: /[\u0370-\u03ff]/.test(captions) ? "el" : "en" } : null) : job.narration;
  if (!said) return null;
  const voices = defaultVoices(VOICE_KEYS, said.language);
  if (!voices.length) throw new Error("This video has no voice yet and neither the engine nor this worker has a speech service. Set AZURE_SPEECH_KEY with AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT.");
  const { speech, failures } = await speakFirst(fetch, VOICE_KEYS, voices, said.text, said.language);
  if (!speech) throw new Error(`The voiceover could not be made: ${failures.join("; ")}`.slice(0, 480));
  log("voiceover", { job: job.id, voice: speech.spec.name, seconds: speech.durationSeconds });
  const composition = layVoiceover(timeline, { source: { kind: "url", url: GENERATED_VOICE }, durationSeconds: speech.durationSeconds, words: speech.words, language: said.language }) as unknown as Job["composition"];
  return { composition, bytes: speech.bytes };
}

async function render(job: Job) {
  const voiced = await voiceover(job);
  if (voiced) job = { ...job, composition: voiced.composition };
  const clips = [...job.composition.video, ...job.composition.audio];
  const linked = clips.map((clip) => clip.source).filter((source) => source.kind === "url" && source.url !== GENERATED_VOICE).map((source) => source.url!);
  const refused = linked.filter((url) => !allowedMediaUrl(url, MEDIA_HOSTS));
  if (refused.length) throw new Error(`Linked media from hosts this worker does not allow: ${[...new Set(refused.map((url) => new URL(url).host))].join(", ")}. Upload them as draft files instead.`);
  const itemMedia = clips.some((clip) => clip.source.kind === "item_media") ? job.itemMedia : null;

  await mkdir(WORK_DIR, { recursive: true });
  const output = join(WORK_DIR, `${job.id}.mp4`);
  const staging = join(WORK_DIR, job.id);
  const { cancelSignal, cancel } = makeCancelSignal();
  let lastBeat = 0;
  let stopped: Error | null = null;
  const beat = async (progress: number) => {
    try {
      await call(`/${job.id}/progress`, { workerId: WORKER_ID, progress: Math.min(0.99, progress) });
    } catch (error) {
      if (error instanceof Gone) {
        stopped = error;
        cancel();
      }
    }
  };
  // The lease is renewed by progress reports; a heartbeat keeps it alive through downloads and slow stretches.
  const heartbeat = setInterval(() => void beat(0), Math.max(30, job.leaseSeconds / 3) * 1000);
  let staged: StagedMedia | null = null;
  try {
    // The renderer only ever sees 127.0.0.1 copies; media.ts fetched each one from an allowed host.
    staged = await stageMedia([...linked, ...(itemMedia ? [itemMedia.url] : []), ...Object.values(job.files).map((file) => file.url)], staging, MEDIA_HOSTS, {
      made: voiced ? [{ key: GENERATED_VOICE, bytes: voiced.bytes, type: "audio/mpeg" }] : [],
    });
    const local = staged.url;
    const relink = <T extends { source: { kind: string; url?: string } }>(clip: T): T => (clip.source.kind === "url" ? { ...clip, source: { ...clip.source, url: local(clip.source.url!) } } : clip);
    const inputProps = {
      composition: { ...job.composition, video: job.composition.video.map(relink), audio: job.composition.audio.map(relink) },
      media: { itemMedia: itemMedia ? local(itemMedia.url) : null, files: Object.fromEntries(Object.entries(job.files).map(([id, file]) => [id, { url: local(file.url), mime: file.mime }])) },
    };
    const url = await bundled();
    const browserExecutable = env.CHROME_EXECUTABLE || null;
    const chromeMode = env.CHROME_MODE === "chrome-for-testing" ? "chrome-for-testing" : "headless-shell";
    const composition = await selectComposition({ serveUrl: url, id: "Reel", inputProps, browserExecutable, chromeMode, logLevel: "warn" });
    await renderMedia({
      composition,
      serveUrl: url,
      codec: "h264",
      audioCodec: "aac",
      pixelFormat: "yuv420p",
      // Limited-range BT.709, what phones and the social platforms expect.
      colorSpace: "bt709",
      outputLocation: output,
      inputProps,
      browserExecutable,
      chromeMode,
      cancelSignal,
      concurrency: env.RENDER_CONCURRENCY ? Number(env.RENDER_CONCURRENCY) : null,
      timeoutInMilliseconds: 120_000,
      logLevel: "warn",
      onProgress: ({ progress }) => {
        if (Date.now() - lastBeat < 5000) return;
        lastBeat = Date.now();
        void beat(progress);
      },
    });
    return { output, durationSeconds: composition.durationInFrames / composition.fps };
  } catch (error) {
    if (stopped) throw stopped;
    throw error;
  } finally {
    clearInterval(heartbeat);
    await staged?.close();
    await rm(staging, { recursive: true, force: true });
  }
}

async function deliver(job: Job, output: string, durationSeconds: number) {
  const bytes = (await stat(output)).size;
  const sha256 = createHash("sha256").update(await readFile(output)).digest("hex");
  const upload = await call<{ url: string; headers: Record<string, string> }>(`/${job.id}/upload-url`, { workerId: WORKER_ID, sha256, bytes });
  const put = await fetch(upload.url, { method: "PUT", headers: { ...upload.headers, "content-length": String(bytes) }, body: createReadStream(output) as unknown as BodyInit, duplex: "half" } as RequestInit);
  if (!put.ok) throw new Error(`The MP4 upload was refused (${put.status}).`);
  await call(`/${job.id}/complete`, { workerId: WORKER_ID, sha256, bytes, durationSeconds: Math.round(durationSeconds * 100) / 100 });
  return { bytes, sha256 };
}

/** Renders one claimed job and delivers it, or tells the engine why it could not. */
async function work(job: Job) {
  const started = Date.now();
  log("claimed", { job: job.id, item: job.itemId, revision: job.compositionRevision, attempt: job.attempt });
  let output: string | null = null;
  try {
    const rendered = await render(job);
    output = rendered.output;
    const delivered = await deliver(job, rendered.output, rendered.durationSeconds);
    log("delivered", { job: job.id, seconds: rendered.durationSeconds, bytes: delivered.bytes, ms: Date.now() - started });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(error instanceof Gone ? "abandoned" : "failed", { job: job.id, message });
    if (!(error instanceof Gone)) await call(`/${job.id}/fail`, { workerId: WORKER_ID, error: message.slice(0, 500) }).catch(() => undefined);
  } finally {
    if (output) await rm(output, { force: true });
  }
}

async function once(): Promise<boolean> {
  const { job } = await call<{ job: Job | null }>("/claim", { workerId: WORKER_ID });
  if (!job) return false;
  await work(job);
  return true;
}

/**
 * One job handed over by a dispatcher that already claimed it (Cloudflare Containers: the Worker claims, then starts a
 * container for the job). Only that dispatcher can reach this port. The process exits when the job is done.
 */
function serve(port: number) {
  let busy = false;
  createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ busy }));
    if (request.method !== "POST" || request.url !== "/run") return void response.writeHead(404).end();
    if (busy) return void response.writeHead(409).end();
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let handed: { workerId?: unknown; job?: Job } = {};
      try {
        handed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* answered below */
      }
      if (typeof handed.workerId !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(handed.workerId) || !handed.job?.id) return void response.writeHead(400).end();
      busy = true;
      WORKER_ID = handed.workerId;
      response.writeHead(202).end();
      void work(handed.job).finally(() => {
        log("finished");
        setTimeout(() => process.exit(0), 200);
      });
    });
  }).listen(port, "0.0.0.0", () => log("serving", { port }));
}

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    log("stopping");
    running = false;
  });

log("started", { api: API, mediaHosts: MEDIA_HOSTS, workDir: resolve(WORK_DIR), voices: Object.entries(VOICE_KEYS).filter(([, keys]) => keys).map(([service]) => service) });
if (!MEDIA_HOSTS.length) log("no_media_hosts", { message: "Set SUPABASE_URL and FACEFUL_R2_ACCOUNT_ID (the engine's), or MEDIA_HOST_ALLOWLIST: renders with media fail until then." });
const SERVE_PORT = Number(env.SERVE_PORT ?? 0);
if (SERVE_PORT) serve(SERVE_PORT);
while (running && !SERVE_PORT) {
  let worked = false;
  try {
    worked = await once();
  } catch (error) {
    log("claim_error", { message: error instanceof Error ? error.message : String(error) });
  }
  if (ONCE) break;
  if (!worked) await sleep(POLL_MS);
}
