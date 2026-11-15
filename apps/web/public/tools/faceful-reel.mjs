#!/usr/bin/env node
/**
 * faceful-reel: upload a reel package to a Faceful workspace through the MCP endpoint.
 *
 * A reel package is a folder with a `reel.json` and the files it names. `reel.json` holds the project,
 * one presenter item, the draft files (script, transcript, voice, avatar clips, music, SFX, images) and a
 * complete version-2 timeline whose clips point at those files as "@<key>". Pushing creates the project
 * (or reuses an item), saves every file as a versioned draft, swaps each "@<key>" for the real file id and
 * saves the timeline, so the result opens in the studio's Video view as separate, editable parts.
 *
 *   node faceful-reel.mjs check <package-dir>
 *   FACEFUL_TOKEN=... node faceful-reel.mjs push <package-dir> [--item <id>] [--render] [--url https://faceful.dtheo.dev]
 *
 * The token is a workspace token from the studio (Connect your agent) with campaign:read and content:edit,
 * plus render:write for --render. Node 18 or later; no dependencies, so an agent can download and run it.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const FORMAT = "faceful-reel/1";
const KEY = /^[A-Za-z0-9_-]{1,40}$/;
const MIMES = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".vtt": "text/vtt", ".srt": "application/x-subrip",
};
const TEXT_FORMATS = { "text/markdown": "markdown", "text/plain": "text", "application/json": "json", "text/vtt": "vtt", "application/x-subrip": "srt" };

const fail = (message) => {
  throw new Error(message);
};

/** Reads and checks a package without touching the network. Returns the parsed manifest and its files. */
export async function loadPackage(dir) {
  const manifest = JSON.parse(await readFile(join(dir, "reel.json"), "utf8"));
  if (manifest.format !== FORMAT) fail(`reel.json must have "format": "${FORMAT}".`);
  if (!manifest.project?.title || !manifest.project?.brand?.name || !manifest.project?.brand?.description) fail("reel.json needs project.title, project.brand.name and project.brand.description.");
  if (!manifest.item?.title || !manifest.item?.script) fail("reel.json needs item.title and item.script.");
  if (manifest.composition?.version !== 2) fail("reel.json needs a version 2 composition.");
  const files = [];
  const keys = new Set();
  for (const entry of manifest.files ?? []) {
    if (!KEY.test(entry.key ?? "")) fail(`File key "${entry.key}" must be 1-40 letters, numbers, dashes or underscores.`);
    if (keys.has(entry.key)) fail(`File key "${entry.key}" is used twice.`);
    keys.add(entry.key);
    if (!entry.kind || !entry.name) fail(`File "${entry.key}" needs a kind and a name.`);
    if (typeof entry.text === "string") {
      const mime = entry.mime ?? "text/markdown";
      if (!TEXT_FORMATS[mime]) fail(`File "${entry.key}": inline text must be markdown, plain text, JSON, VTT or SRT.`);
      files.push({ ...entry, mime, text: entry.text });
      continue;
    }
    if (!entry.path) fail(`File "${entry.key}" needs a path or inline text.`);
    // Paths stay inside the package, so a manifest cannot read files elsewhere on the machine.
    const root = resolve(dir);
    const path = resolve(root, entry.path);
    if (isAbsolute(entry.path) || !path.startsWith(root + sep)) fail(`File "${entry.key}": path must be inside the package folder.`);
    const mime = entry.mime ?? MIMES[extname(path).toLowerCase()];
    if (!mime) fail(`File "${entry.key}": unknown type for ${entry.path}; set "mime".`);
    const info = await stat(path).catch(() => fail(`File "${entry.key}": ${entry.path} does not exist.`));
    files.push({ ...entry, mime, path, bytes: info.size });
  }
  for (const ref of fileRefs(manifest.composition)) if (!keys.has(ref)) fail(`The timeline uses "@${ref}", which is not in files.`);
  return { manifest, files };
}

/** Every "@key" the timeline points at. */
export function fileRefs(composition) {
  const refs = new Set();
  const take = (id) => typeof id === "string" && id.startsWith("@") && refs.add(id.slice(1));
  for (const clip of [...(composition.video ?? []), ...(composition.audio ?? [])]) if (clip.source?.kind === "file") take(clip.source.fileId);
  for (const card of composition.cards ?? []) take(card.imageFileId);
  take(composition.transcript?.sourceFileId);
  return [...refs];
}

/** The timeline with every "@key" replaced by the uploaded file's id. */
export function bindComposition(composition, ids) {
  const bind = (id) => (typeof id === "string" && id.startsWith("@") ? ids[id.slice(1)] ?? fail(`No uploaded file for "${id}".`) : id);
  const bound = structuredClone(composition);
  for (const clip of [...bound.video, ...bound.audio]) if (clip.source.kind === "file") clip.source.fileId = bind(clip.source.fileId);
  for (const card of bound.cards) card.imageFileId = card.imageFileId === null ? null : bind(card.imageFileId);
  if (bound.transcript) bound.transcript.sourceFileId = bound.transcript.sourceFileId === null ? null : bind(bound.transcript.sourceFileId);
  return bound;
}

/** One MCP tool call over the stateless JSON-RPC endpoint. Throws with the tool's own message on errors. */
function mcpClient({ url, token, fetch: send = globalThis.fetch, wait = (ms) => new Promise((done) => setTimeout(done, ms)), log = () => {} }) {
  let id = 0;
  return async function call(name, args) {
    for (let attempt = 1; ; attempt++) {
      const response = await send(new URL("/mcp", url), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      });
      const text = await response.text();
      // A streamable-HTTP server may answer as one SSE event; take the JSON from its data lines.
      const body = (response.headers.get("content-type") ?? "").includes("text/event-stream")
        ? JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join(""))
        : JSON.parse(text || "{}");
      if (!response.ok || body.error) fail(`${name}: ${body.error?.message ?? `HTTP ${response.status}`}`);
      const result = body.result ?? {};
      const retryAfter = result.structuredContent?.retryAfterSeconds;
      // Upload links are rate limited per minute, so a package with many files waits for the next window instead of
      // failing. The limit is checked before anything is done, so asking again is safe.
      if (result.isError && result.structuredContent?.code === "quota_exceeded" && retryAfter > 0 && retryAfter <= 60 && attempt < 4) {
        log(`Waiting ${retryAfter} s for the workspace's upload limit.`);
        await wait(retryAfter * 1000);
        continue;
      }
      if (result.isError) fail(`${name}: ${result.structuredContent?.message ?? result.content?.[0]?.text ?? "failed"}`);
      return result.structuredContent ?? {};
    }
  };
}

/**
 * Uploads a package and saves its timeline. `itemId` reuses an existing presenter item (its project is
 * read from the timeline); otherwise a new project is created from `project` and `item`.
 */
export async function pushPackage({ dir, url, token, itemId = null, render = false, fetch: send = globalThis.fetch, log = () => {}, wait }) {
  const { manifest, files } = await loadPackage(dir);
  const call = mcpClient({ url, token, fetch: send, log, ...(wait ? { wait } : {}) });
  let projectId;
  if (itemId) {
    projectId = (await call("get_video_timeline", { itemId })).campaignId;
    log(`Using item ${itemId} in project ${projectId}.`);
  } else {
    const { project } = await call("create_project", {
      title: manifest.project.title.slice(0, 120),
      brand: manifest.project.brand,
      drafts: [{ title: manifest.item.title.slice(0, 120), script: manifest.item.script.slice(0, 5000) }],
      ...(manifest.project.language ? { language: manifest.project.language } : {}),
    });
    projectId = project.id;
    itemId = project.items[0].id;
    log(`Created project ${projectId} with item ${itemId}.`);
  }

  const ids = {};
  for (const file of files) {
    const common = { projectId, itemId, kind: file.kind, name: file.name, meta: file.meta ?? {} };
    if (file.text !== undefined || TEXT_FORMATS[file.mime]) {
      const text = file.text ?? (await readFile(file.path, "utf8"));
      ids[file.key] = (await call("save_text_draft", { ...common, format: TEXT_FORMATS[file.mime], text })).file.id;
    } else {
      const bytes = await readFile(file.path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const ticket = await call("request_file_upload", { ...common, mime: file.mime, bytes: bytes.byteLength, sha256, ...(file.durationSeconds ? { durationSeconds: file.durationSeconds } : {}) });
      if (ticket.upload) {
        const put = await send(ticket.upload.url, { method: "PUT", headers: ticket.upload.headers, body: bytes });
        if (!put.ok) fail(`Uploading ${file.name} failed with HTTP ${put.status}.`);
        await call("complete_file_upload", { fileId: ticket.file.id });
      }
      ids[file.key] = ticket.file.id;
    }
    log(`Saved ${file.kind} "${file.name}".`);
  }

  const current = await call("get_video_timeline", { itemId });
  const saved = await call("save_video_timeline", { itemId, expectedRevision: current.revision, composition: bindComposition(manifest.composition, ids), idempotencyKey: randomUUID() });
  log(`Saved the timeline as revision ${saved.revision}.`);
  let queued = null;
  if (render) {
    queued = (await call("queue_video_render", { itemId, expectedRevision: saved.revision })).render;
    log(`Queued render ${queued.id}.`);
  }
  return { projectId, itemId, fileIds: ids, revision: saved.revision, studioUrl: saved.studioUrl, render: queued };
}

async function main(argv) {
  const [command, dir, ...rest] = argv;
  const flag = (name) => {
    const index = rest.indexOf(name);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  if (!dir || !["check", "push"].includes(command)) {
    console.log("Usage:\n  node faceful-reel.mjs check <package-dir>\n  FACEFUL_TOKEN=... node faceful-reel.mjs push <package-dir> [--item <id>] [--render] [--url <origin>]");
    process.exitCode = 2;
    return;
  }
  if (command === "check") {
    const { manifest, files } = await loadPackage(dir);
    const megabytes = files.reduce((sum, file) => sum + (file.bytes ?? 0), 0) / 1048576;
    console.log(`OK: "${manifest.project.title}", ${files.length} files (${megabytes.toFixed(1)} MB), ${manifest.composition.durationSeconds}s timeline.`);
    return;
  }
  const token = process.env.FACEFUL_TOKEN;
  if (!token) fail("Set FACEFUL_TOKEN to a workspace token from the studio (Connect your agent).");
  const result = await pushPackage({ dir, url: flag("--url") ?? process.env.FACEFUL_URL ?? "https://faceful.dtheo.dev", token, itemId: flag("--item") ?? null, render: rest.includes("--render"), log: (line) => console.log(line) });
  console.log(`\nOpen it: ${result.studioUrl}\nItem id (for --item next time): ${result.itemId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(`faceful-reel: ${error.message}`);
    process.exitCode = 1;
  });
