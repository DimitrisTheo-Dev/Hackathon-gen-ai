/**
 * Render worker client — the seam between Faceful's durable render jobs and the Humanlike recorder.
 *
 * Humanlike's documented API starts REALTIME avatar sessions in a LiveKit room; it does not return
 * a video file. Whatever records such a session to MP4/WebM (LiveKit egress, a room recorder, …)
 * plugs in here: this client claims a queued job, hands the script/avatar to the recorder, uploads
 * the resulting file to Faceful's private storage and reports the real outcome. Faceful verifies the
 * stored object (size, SHA-256) before a job can become "succeeded".
 *
 * Environment:  FACEFUL_API_URL (e.g. https://faceful.vercel.app)   RENDER_WORKER_TOKEN (same value as the deployment)
 *               HUMANLIKE_API_KEY (only for `avatars`)
 *
 *   tsx scripts/render-worker.ts avatars
 *   tsx scripts/render-worker.ts claim
 *   tsx scripts/render-worker.ts progress <jobId> --status "session started" [--provider-job <id>]
 *   tsx scripts/render-worker.ts complete <jobId> --file out.mp4 --duration 15.2 [--width 512 --height 512] [--no-audio] [--provider-job <id>]
 *   tsx scripts/render-worker.ts fail <jobId> --code provider_unavailable --message "why"
 *   tsx scripts/render-worker.ts run --exec "./record.sh" [--interval 5] [--once]
 *
 * `run` loops: claim → execute the recorder with FACEFUL_JOB_ID, FACEFUL_SCRIPT, FACEFUL_AVATAR_ID,
 * FACEFUL_LANGUAGE and FACEFUL_OUTPUT (where to write the .mp4) → the recorder's LAST stdout line must be
 * JSON {"durationSeconds":15.2,"hasAudio":true,"width":512,"height":512,"providerJobId":"…"} → upload → complete.
 * A non-zero exit, a missing file or invalid JSON fails the job (its held credit is returned).
 */
import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHumanlikeClient } from "../packages/engine/src/providers/humanlike";

const [command, ...rest] = process.argv.slice(2);
const flags: Record<string, string | true> = {};
const positional: string[] = [];
for (let index = 0; index < rest.length; index++) {
  const value = rest[index];
  if (!value.startsWith("--")) positional.push(value);
  else if (rest[index + 1] === undefined || rest[index + 1].startsWith("--")) flags[value.slice(2)] = true;
  else flags[value.slice(2)] = rest[++index];
}
const text = (name: string) => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
function need(name: string) {
  const value = text(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const base = (process.env.FACEFUL_API_URL ?? "").replace(/\/$/, "");
const token = process.env.RENDER_WORKER_TOKEN ?? "";
async function api(path: string, body: unknown) {
  if (!base || !token) throw new Error("Set FACEFUL_API_URL and RENDER_WORKER_TOKEN.");
  const response = await fetch(`${base}/v1/worker${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} → ${response.status} ${payload?.error?.code ?? ""}: ${payload?.error?.message ?? "request failed"}`);
  return payload;
}

async function complete(jobId: string, file: string, meta: { durationSeconds: number; hasAudio: boolean; width?: number; height?: number; providerJobId?: string }) {
  const mime = file.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";
  const { size } = await stat(file);
  if (!size) throw new Error("The rendered file is empty.");
  const upload = await api(`/render/${jobId}/upload-url`, { mime });
  const put = await fetch(upload.uploadUrl, { method: "PUT", headers: upload.headers, body: await readFile(file) });
  if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
  return api(`/render/${jobId}/complete`, meta);
}

function record(exec: string, env: Record<string, string>): Promise<{ code: number; lastLine: string }> {
  return new Promise((resolve) => {
    const child = spawn(exec, { shell: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code: code ?? 1, lastLine: out.trim().split("\n").pop() ?? "" }));
  });
}

if (command === "avatars") {
  const key = process.env.HUMANLIKE_API_KEY;
  if (!key) throw new Error("Set HUMANLIKE_API_KEY (a secret hk_live_… key) to list Humanlike avatars.");
  const { defaultId, avatars } = await createHumanlikeClient({ apiKey: key, apiUrl: process.env.HUMANLIKE_API_URL ?? "https://api.humanlike.co", fetch }).listAvatars();
  console.log(JSON.stringify({ default: defaultId, avatars, note: "Only avatars whose renderModes include \"video\" can be recorded to a file." }, null, 2));
} else if (command === "claim") {
  console.log(JSON.stringify(await api("/render/claim", { workerId: text("worker") ?? "manual" }), null, 2));
} else if (command === "progress") {
  console.log(JSON.stringify(await api(`/render/${positional[0]}/progress`, { providerStatus: need("status"), ...(text("provider-job") ? { providerJobId: text("provider-job") } : {}) })));
} else if (command === "complete") {
  console.log(JSON.stringify(await complete(positional[0], need("file"), { durationSeconds: Number(need("duration")), hasAudio: flags["no-audio"] !== true, ...(text("width") ? { width: Number(text("width")) } : {}), ...(text("height") ? { height: Number(text("height")) } : {}), ...(text("provider-job") ? { providerJobId: text("provider-job") } : {}) })));
} else if (command === "fail") {
  console.log(JSON.stringify(await api(`/render/${positional[0]}/fail`, { code: text("code") ?? "provider_unavailable", message: need("message") })));
} else if (command === "run") {
  const exec = need("exec");
  const interval = Number(text("interval") ?? 5) * 1000;
  for (;;) {
    const { job } = await api("/render/claim", { workerId: text("worker") ?? "recorder" });
    if (!job) {
      if (flags.once) break;
      await new Promise((resolve) => setTimeout(resolve, interval));
      continue;
    }
    const output = join(tmpdir(), `faceful-${job.id}.mp4`);
    console.error(`Claimed ${job.id} (item ${job.itemId} r${job.revision}, avatar ${job.avatarId}, ${job.language})`);
    try {
      const { code, lastLine } = await record(exec, { FACEFUL_JOB_ID: job.id, FACEFUL_SCRIPT: job.script, FACEFUL_AVATAR_ID: job.avatarId ?? "", FACEFUL_LANGUAGE: job.language, FACEFUL_OUTPUT: output });
      if (code !== 0) throw new Error(`The recorder exited with code ${code}.`);
      const meta = JSON.parse(lastLine);
      console.error(JSON.stringify(await complete(job.id, output, meta)));
    } catch (error) {
      const message = (error instanceof Error ? error.message : "The recorder failed.").slice(0, 480);
      console.error(`Failing ${job.id}: ${message}`);
      await api(`/render/${job.id}/fail`, { code: "provider_unavailable", message }).catch((failure) => console.error(String(failure)));
    } finally {
      await rm(output, { force: true });
    }
    if (flags.once) break;
  }
} else {
  console.error("Commands: avatars | claim | progress <jobId> | complete <jobId> | fail <jobId> | run --exec <recorder>. See the header of this file.");
  process.exitCode = 1;
}
