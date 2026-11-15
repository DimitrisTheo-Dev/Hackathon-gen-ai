import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compositionSchema } from "../packages/contracts/src/index";
import { handleMcpRequest } from "../packages/engine/src/mcp";
import type { MemoryStore } from "../packages/engine/src/store-memory";
import { packageFromOpenMontage, wavSeconds } from "../scripts/reel/from-openmontage";
import { engine } from "./reel-support";

// The uploader is a plain .mjs file served to agents; load it untyped.
const TOOL = "../apps/web/public/tools/faceful-reel.mjs";
const reel: { loadPackage: (dir: string) => Promise<any>; pushPackage: (options: Record<string, unknown>) => Promise<any> } = await import(TOOL);

function wav(seconds: number, rate = 8000) {
  const samples = Math.round(seconds * rate);
  const buffer = Buffer.alloc(44 + samples, 128);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + samples, 4); buffer.write("WAVE", 8); buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate, 28); buffer.writeUInt16LE(1, 32); buffer.writeUInt16LE(8, 34); buffer.write("data", 36); buffer.writeUInt32LE(samples, 40);
  return buffer;
}

const beats = [
  { id: "hook", say: "Do you check your blood pressure at home?", start: 0.1, end: 2.4, words: [{ t: "Do", s: 0.1, e: 0.3 }, { t: "you", s: 0.32, e: 0.5 }, { t: "check", s: 0.55, e: 0.9 }, { t: "your", s: 0.95, e: 1.1 }, { t: "blood", s: 1.15, e: 1.5 }, { t: "pressure", s: 1.55, e: 2.0 }, { t: "at", s: 2.02, e: 2.1 }, { t: "home?", s: 2.12, e: 2.4 }] },
  { id: "cta", say: "Write them down.", start: 2.8, end: 4.0, words: [{ t: "Write", s: 2.8, e: 3.2 }, { t: "them", s: 3.25, e: 3.5 }, { t: "down.", s: 3.55, e: 4.0 }] },
];

/** A small run folder shaped like templates/face/<slug> after `build.py`, with the kit's SFX one level up. */
async function openMontageRun({ presenter = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "reel-run-"));
  const run = join(root, "talking-tip");
  await mkdir(join(run, "artifacts"), { recursive: true });
  await mkdir(join(run, "public", "clips"), { recursive: true });
  await mkdir(join(run, "assets", "audio"), { recursive: true });
  await mkdir(join(run, "assets", "music"), { recursive: true });
  await mkdir(join(root, "_kit", "sfx"), { recursive: true });
  const props = {
    fps: 25, durationInFrames: 125, duration: 5, lang: "en", topic: "Measuring blood pressure at home",
    brand: { name: "Sample Practice", handle: "@sample.practice", colors: { ink: "#FFFFFF", accent: "#FFD23F", shade: "#101014" } },
    cta: { line: "Write them down." }, beats,
    ...(presenter ? { segments: [{ name: "s1", start: 0, end: 5, from: 0, dur: 110, clip: "clips/s1.mp4" }, { name: "tail", start: 4.4, end: 5, from: 110, dur: 15, clip: "clips/tail.mp4", trim: 10 }] } : {}),
  };
  await writeFile(join(run, "artifacts", "props.json"), JSON.stringify(props));
  await writeFile(join(run, "artifacts", "audio_report.json"), JSON.stringify({ mix_offset_ms: 5, music_gain_db: -14.8, sfx: [["tick", 1.98, 0.07], ["pop", 4.24, 0.09], ["missing", 2.5, 0.1]] }));
  await writeFile(join(run, "spec.json"), JSON.stringify({ template: "talking-tip", voice: { engine: "elevenlabs", name: "Sample" }, music: { prompt: "Warm acoustic bed" } }));
  await writeFile(join(run, "public", "clips", "s1.mp4"), Buffer.alloc(2048, 1));
  await writeFile(join(run, "public", "clips", "tail.mp4"), Buffer.alloc(1024, 2));
  await writeFile(join(run, "assets", "audio", "voice_enh.wav"), wav(4.5));
  await writeFile(join(run, "assets", "music", "bed.mp3"), Buffer.alloc(512, 3));
  await writeFile(join(run, "sample.mp4"), Buffer.alloc(4096, 4));
  await writeFile(join(root, "_kit", "sfx", "tick.wav"), wav(0.06));
  await writeFile(join(root, "_kit", "sfx", "pop.wav"), wav(0.14));
  return run;
}

test("WAV lengths come from the header", () => {
  assert.equal(wavSeconds(wav(1.5)), 1.5);
  assert.equal(wavSeconds(new Uint8Array(8)), null);
});

test("an OpenMontage presenter run becomes separate parts on the studio timeline", async () => {
  const out = await mkdtemp(join(tmpdir(), "reel-pkg-"));
  const manifest = await packageFromOpenMontage(await openMontageRun(), out);
  const composition = compositionSchema.parse(manifest.composition);

  assert.deepEqual(manifest.files.map((file: { key: string }) => file.key), ["script", "transcript", "spec", "clip_s1", "clip_tail", "voice", "music", "sfx_tick", "sfx_pop"]);
  // Presenter segments keep their frame placement and the tail's trim, muted under the separate voice take.
  assert.deepEqual(composition.video.map((clip) => [clip.id, clip.start, clip.end, clip.in, clip.volume, clip.source]), [
    ["presenter-s1", 0, 4.4, 0, 0, { kind: "file", fileId: "@clip_s1" }],
    ["presenter-tail", 4.4, 5, 0.4, 0, { kind: "file", fileId: "@clip_tail" }],
  ]);
  const byId = Object.fromEntries(composition.audio.map((clip) => [clip.id, clip]));
  assert.deepEqual([byId.voice.start, byId.voice.end, byId.voice.volume], [0.005, 4.505, 1]);
  assert.equal(byId.music.volume, 0.18, "the bed plays at the run's -14.8 dB");
  assert.deepEqual([byId["sfx-1"].start, byId["sfx-1"].end, byId["sfx-1"].volume], [1.98, 2.04, 0.07]);
  assert.equal(byId["sfx-3"], undefined, "a sound the kit does not have is left out");
  assert.equal(composition.transcript?.words.length, 11);
  assert.equal(composition.transcript?.sourceFileId, "@transcript");
  assert.ok(composition.captions.length >= 3);
  assert.ok(composition.captions.every((cue) => cue.end <= 4));
  assert.deepEqual(composition.cards.map((card) => [card.kind, card.title, card.subtitle, card.start]), [["cta", "Sample Practice", "@sample.practice", 4]]);
  assert.equal(composition.style.accent, "#FFD23F");
  assert.equal(composition.labels.aiAvatar, true);
  assert.equal(manifest.item.script, "Do you check your blood pressure at home? Write them down.");

  const checked = await reel.loadPackage(out);
  assert.equal(checked.files.find((file: { key: string }) => file.key === "clip_s1").bytes, 2048);
  assert.deepEqual(await readFile(join(out, "media", "clip_s1.mp4")), Buffer.alloc(2048, 1));
});

test("a run with no presenter keeps its rendered pictures as one clip with their own sound", async () => {
  const out = await mkdtemp(join(tmpdir(), "reel-pkg-"));
  const manifest = await packageFromOpenMontage(await openMontageRun({ presenter: false }), out);
  assert.deepEqual(manifest.composition.video.map((clip: { id: string; volume: number }) => [clip.id, clip.volume]), [["visuals", 1]]);
  assert.deepEqual([manifest.composition.audio.length, manifest.composition.captions.length, manifest.composition.cards.length], [0, 0, 0]);
  assert.equal(manifest.composition.labels.aiAvatar, false);
});

test("a package cannot name files outside its folder or use a file it does not list", async () => {
  const out = await mkdtemp(join(tmpdir(), "reel-pkg-"));
  await packageFromOpenMontage(await openMontageRun(), out);
  const manifest = JSON.parse(await readFile(join(out, "reel.json"), "utf8"));
  await writeFile(join(out, "reel.json"), JSON.stringify({ ...manifest, files: [...manifest.files.slice(0, 3), { key: "voice", kind: "voice", name: "Voice", path: "../../etc/passwd" }] }));
  await assert.rejects(reel.loadPackage(out), /inside the package folder/);
  await writeFile(join(out, "reel.json"), JSON.stringify({ ...manifest, files: manifest.files.filter((file: { key: string }) => file.key !== "music") }));
  await assert.rejects(reel.loadPackage(out), /uses "@music"/);
});

test("an agent with MCP only builds a project of separate parts from https links, without uploading", async () => {
  const env = engine();
  const ctx = await env.as("user:u1");
  const token = await env.agentToken(ctx, ["campaign:read", "content:edit"]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = (await handleMcpRequest(env.deps, new Request("https://faceful.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), "/mcp"))!;
    const { result } = (await response.json()) as { result: { isError?: boolean; structuredContent: any } };
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  const { project } = await call("create_project", { title: "Home blood pressure", brand: { name: "Sample Practice", description: "A family practice." }, drafts: [{ title: "Measure it right", script: "Sit quietly for five minutes first." }] });
  const itemId = project.items[0].id;
  const transcript = await call("save_text_draft", { projectId: project.id, itemId, kind: "transcript", name: "Word timings", format: "json", text: JSON.stringify({ words: [{ t: "Sit", start: 0.1, end: 0.4 }] }) });
  const { composition, revision } = await call("get_video_timeline", { itemId });
  composition.video = [{ ...composition.video[0], source: { kind: "url", url: "https://cdn.example.com/presenter.mp4" }, volume: 0 }];
  composition.audio = [{ id: "voice", start: 0, end: 3, source: { kind: "url", url: "https://cdn.example.com/voice.mp3" }, in: 0, role: "voice", volume: 1, fadeIn: 0, fadeOut: 0, loop: false }];
  composition.transcript = { language: "en", words: [{ t: "Sit", start: 0.1, end: 0.4 }], sourceFileId: transcript.file.id };
  const saved = await call("save_video_timeline", { itemId, expectedRevision: revision, composition });
  assert.equal(saved.revision, 1);
  const read = await call("get_video_timeline", { itemId });
  assert.deepEqual(read.composition.audio[0].source, { kind: "url", url: "https://cdn.example.com/voice.mp3" });
});

test("pushing a package through MCP creates the project, every draft file and the timeline", async () => {
  const env = engine();
  const ctx = await env.as("user:u1");
  const token = await env.agentToken(ctx, ["campaign:read", "content:edit"]);
  const out = await mkdtemp(join(tmpdir(), "reel-pkg-"));
  await packageFromOpenMontage(await openMontageRun(), out);
  const puts: string[] = [];
  // The engine answers /mcp in-process; uploads land in the memory file store only if the checksum header matches, as R2 enforces.
  const send = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/mcp") return (await handleMcpRequest(env.deps, new Request(url, init), "/mcp"))!;
    assert.equal(init.method, "PUT");
    const bytes = new Uint8Array(init.body as Buffer);
    const headers = init.headers as Record<string, string>;
    if (createHash("sha256").update(bytes).digest("base64") !== headers["x-amz-checksum-sha256"]) return new Response("BadDigest", { status: 400 });
    await env.files.put(url.pathname.replace(/^\/upload\//, ""), bytes, headers["content-type"]);
    puts.push(url.pathname);
    return new Response(null, { status: 200 });
  };

  // Rate-limit windows follow the test's clock, and waiting for the next one moves it on.
  (env.deps.store as MemoryStore).clock = env.deps.now;
  const waits: number[] = [];
  const wait = async (ms: number) => {
    waits.push(ms);
    env.advance(ms / 60_000);
  };
  const first = await reel.pushPackage({ dir: out, url: "https://faceful.test", token, fetch: send, wait });
  assert.equal(first.revision, 1);
  assert.match(first.studioUrl, new RegExp(`view=video&campaign=${first.projectId}&item=${first.itemId}`));
  // Six media parts are uploaded; the three text parts are saved as text drafts.
  assert.equal(puts.length, 6);
  const files = await env.deps.store.select("project_files", { project_id: first.projectId });
  assert.equal(files.length, 9);
  assert.ok(files.every((file) => file.state === "ready"));
  const [stored] = await env.deps.store.select("video_compositions", { item_id: first.itemId });
  const composition = compositionSchema.parse(stored.composition);
  assert.equal(composition.video[0].source.kind === "file" && composition.video[0].source.fileId, first.fileIds.clip_s1);
  assert.equal(composition.transcript?.sourceFileId, first.fileIds.transcript);

  // Pushing again into the same item adds a timeline revision and file versions, not a new project.
  const again = await reel.pushPackage({ dir: out, url: "https://faceful.test", token, itemId: first.itemId, fetch: send, wait });
  assert.deepEqual([again.projectId, again.itemId, again.revision], [first.projectId, first.itemId, 2]);
  // Twelve upload links in one minute is over the costly limit of ten: the tool waited for the next window once.
  assert.deepEqual(waits, [60_000]);
  assert.equal((await env.deps.store.select("projects", { org_id: ctx.org.id })).length, 1);
});
