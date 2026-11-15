import { createHash } from "node:crypto";
import {
  archiveFileInputSchema,
  completeUploadInputSchema,
  draftFileSchema,
  requestUploadInputSchema,
  saveTextFileInputSchema,
  uploadTicketSchema,
  type DraftFile,
  type ResolvedMedia,
  type UploadTicket,
} from "../../contracts/src/index.js";
import { audit, idempotent, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";
import { UnconfiguredFileStore, type FileStore } from "./r2.js";
import { selectOne, type Row } from "./store.js";
import { loadItem, loadProject, parse } from "./studio.js";

/**
 * Draft files: every component of a reel (script, facts, voice takes, avatar clips, music, SFX,
 * images, transcripts, cut lists, renders) kept as its own versioned file in the project.
 * Bytes live in R2 under a content address; Postgres holds who added what, when, and from where.
 */
export const FILES_TABLE = "project_files";
const UPLOAD_TTL_SECONDS = 15 * 60;
const EXTENSIONS: Record<string, string> = {
  "text/markdown": "md",
  "text/plain": "txt",
  "application/json": "json",
  "text/vtt": "vtt",
  "application/x-subrip": "srt",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const filesOf = (deps: EngineDeps): FileStore => deps.files ?? new UnconfiguredFileStore();
/** Content-addressed and scoped to one project: identical bytes are stored once, and no key crosses workspaces. */
export const fileKey = (orgId: string, projectId: string, sha256: string, mime: string) => `orgs/${orgId}/projects/${projectId}/files/${sha256}.${EXTENSIONS[mime] ?? "bin"}`;
const iso = (value: string | Date) => new Date(value).toISOString();

export async function fileContract(deps: EngineDeps, row: Row): Promise<DraftFile> {
  const ready = row.state === "ready";
  const ttl = deps.config.mediaUrlTtlSeconds;
  return parse(draftFileSchema, {
    id: row.id,
    campaignId: row.project_id,
    itemId: row.item_id ?? null,
    kind: row.kind,
    name: row.name,
    mime: row.mime,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined ? null : Number(row.duration_seconds),
    meta: row.meta ?? {},
    state: row.state,
    version: row.version,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    url: ready ? await filesOf(deps).downloadUrl(row.storage_key, ttl, row.name) : null,
    urlExpiresAt: ready ? new Date(deps.now().getTime() + ttl * 1000).toISOString() : null,
  });
}

async function nextVersion(deps: EngineDeps, ctx: Ctx, projectId: string, itemId: string | null, name: string) {
  const rows = await deps.store.select(FILES_TABLE, { org_id: ctx.org.id, project_id: projectId, item_id: itemId, name }, { order: ["version", "desc"], limit: 1 });
  return (rows[0]?.version ?? 0) + 1;
}

async function scope(deps: EngineDeps, ctx: Ctx, campaignId: string, itemId: string | null) {
  const project = await loadProject(deps, ctx, campaignId);
  if (itemId) {
    const item = await loadItem(deps, ctx, itemId);
    if (item.project_id !== project.id) throw new EngineError("validation_error", "That item belongs to a different project.");
  }
  return project;
}

export async function listFiles(deps: EngineDeps, ctx: Ctx, campaignId: string): Promise<DraftFile[]> {
  requireScope(ctx, "campaign:read");
  const project = await loadProject(deps, ctx, campaignId);
  const rows = await deps.store.select(FILES_TABLE, { org_id: ctx.org.id, project_id: project.id, state: { neq: "archived" } }, { order: ["created_at", "desc"], limit: 500 });
  return Promise.all(rows.map((row) => fileContract(deps, row)));
}

export async function requestUpload(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<UploadTicket> {
  requireScope(ctx, "content:edit");
  const input = parse(requestUploadInputSchema, raw);
  return idempotent(deps, ctx, "request_file_upload", input.operationKey, input, async () => {
    const files = filesOf(deps);
    const project = await scope(deps, ctx, input.campaignId, input.itemId);
    const key = fileKey(ctx.org.id, project.id, input.sha256, input.mime);
    const existing = await files.head(key);
    // Identical bytes already stored for this project: record the new draft without a second upload.
    const ready = !!existing && existing.bytes === input.bytes;
    const now = deps.now().toISOString();
    const row = await deps.store.insert(FILES_TABLE, {
      id: crypto.randomUUID(),
      org_id: ctx.org.id,
      project_id: project.id,
      item_id: input.itemId,
      kind: input.kind,
      name: input.name,
      mime: input.mime,
      bytes: input.bytes,
      sha256: input.sha256,
      duration_seconds: input.durationSeconds,
      meta: input.meta,
      state: ready ? "ready" : "pending",
      version: await nextVersion(deps, ctx, project.id, input.itemId, input.name),
      storage_key: key,
      created_by: ctx.actorLabel,
      actor_id: ctx.actorId,
      created_at: now,
      updated_at: now,
    });
    if (ready) await audit(deps, ctx, { projectId: project.id, action: `Added draft file ${input.name}`, objectId: row.id, revision: row.version, outcome: `${input.kind}, already stored` });
    const upload = ready
      ? null
      : { ...(await files.uploadUrl(key, { sha256Hex: input.sha256, contentType: input.mime, expiresSeconds: UPLOAD_TTL_SECONDS })), method: "PUT" as const, expiresAt: new Date(deps.now().getTime() + UPLOAD_TTL_SECONDS * 1000).toISOString() };
    return parse(uploadTicketSchema, { file: await fileContract(deps, row), upload });
  });
}

export async function completeUpload(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<DraftFile> {
  requireScope(ctx, "content:edit");
  const input = parse(completeUploadInputSchema, raw);
  return idempotent(deps, ctx, "complete_file_upload", input.operationKey, input, async () => {
    const row = await selectOne(deps.store, FILES_TABLE, { id: input.fileId, org_id: ctx.org.id });
    if (!row || row.state === "archived") throw new EngineError("not_found", "This draft file was not found in your workspace.");
    if (row.state === "ready") return fileContract(deps, row);
    const stored = await filesOf(deps).head(row.storage_key);
    if (!stored) throw new EngineError("validation_error", "The upload has not arrived yet. Upload the file with the link you were given, then try again.");
    // R2 already refused any body whose SHA-256 differs from the declared one; the size closes the loop.
    if (stored.bytes !== Number(row.bytes)) throw new EngineError("validation_error", "The stored file's size does not match what was declared. Upload it again.");
    const updated = await deps.store.update(FILES_TABLE, { id: row.id, org_id: ctx.org.id, state: "pending" }, { state: "ready", updated_at: deps.now().toISOString() });
    const final = updated[0] ?? (await selectOne(deps.store, FILES_TABLE, { id: row.id, org_id: ctx.org.id }))!;
    await audit(deps, ctx, { projectId: row.project_id, action: `Added draft file ${row.name}`, objectId: row.id, revision: row.version, outcome: row.kind });
    return fileContract(deps, final);
  });
}

/** Small text drafts (scripts, facts, transcripts, cut lists) written by the engine in one call. */
export async function saveTextFile(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<DraftFile> {
  requireScope(ctx, "content:edit");
  const input = parse(saveTextFileInputSchema, raw);
  return idempotent(deps, ctx, "save_text_file", input.operationKey, input, async () => {
    const project = await scope(deps, ctx, input.campaignId, input.itemId);
    if (input.mime === "application/json") {
      try {
        JSON.parse(input.text);
      } catch {
        throw new EngineError("validation_error", "The text is marked as JSON but is not valid JSON.");
      }
    }
    const bytes = new TextEncoder().encode(input.text);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = fileKey(ctx.org.id, project.id, sha256, input.mime);
    if (!(await filesOf(deps).head(key))) await filesOf(deps).put(key, bytes, `${input.mime}; charset=utf-8`);
    const now = deps.now().toISOString();
    const row = await deps.store.insert(FILES_TABLE, {
      id: crypto.randomUUID(),
      org_id: ctx.org.id,
      project_id: project.id,
      item_id: input.itemId,
      kind: input.kind,
      name: input.name,
      mime: input.mime,
      bytes: bytes.byteLength,
      sha256,
      duration_seconds: input.durationSeconds,
      meta: input.meta,
      state: "ready",
      version: await nextVersion(deps, ctx, project.id, input.itemId, input.name),
      storage_key: key,
      created_by: ctx.actorLabel,
      actor_id: ctx.actorId,
      created_at: now,
      updated_at: now,
    });
    await audit(deps, ctx, { projectId: project.id, action: `Saved draft file ${input.name}`, objectId: row.id, revision: row.version, outcome: input.kind });
    return fileContract(deps, row);
  });
}

/** Archiving hides a draft and stops new timelines from using it. The bytes stay, so history stays playable. */
export async function archiveFile(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<DraftFile> {
  requireScope(ctx, "content:edit");
  const input = parse(archiveFileInputSchema, raw);
  return idempotent(deps, ctx, "archive_file", input.operationKey, input, async () => {
    const row = await selectOne(deps.store, FILES_TABLE, { id: input.fileId, org_id: ctx.org.id });
    if (!row) throw new EngineError("not_found", "This draft file was not found in your workspace.");
    const [updated] = await deps.store.update(FILES_TABLE, { id: row.id, org_id: ctx.org.id }, { state: "archived", updated_at: deps.now().toISOString() });
    await audit(deps, ctx, { projectId: row.project_id, action: `Archived draft file ${row.name}`, objectId: row.id, revision: row.version, outcome: "Hidden from the project" });
    return fileContract(deps, updated);
  });
}

/** Ready files of one project by id, with fresh links. Ids that are missing, pending or archived are left out. */
export async function resolveFiles(deps: EngineDeps, orgId: string, projectId: string, ids: string[], ttlSeconds: number): Promise<Record<string, ResolvedMedia>> {
  if (!ids.length) return {};
  const rows = await deps.store.select(FILES_TABLE, { org_id: orgId, project_id: projectId, id: { in: ids }, state: "ready" });
  const expiresAt = new Date(deps.now().getTime() + ttlSeconds * 1000).toISOString();
  const entries = await Promise.all(
    rows.map(async (row) => [row.id, { url: await filesOf(deps).downloadUrl(row.storage_key, ttlSeconds), mime: row.mime, expiresAt, durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined ? null : Number(row.duration_seconds), name: row.name }] as const),
  );
  return Object.fromEntries(entries);
}

export async function assertFilesReady(deps: EngineDeps, ctx: Ctx, projectId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await deps.store.select(FILES_TABLE, { org_id: ctx.org.id, project_id: projectId, id: { in: ids }, state: "ready" });
  const missing = ids.filter((id) => !rows.some((row) => row.id === id));
  if (missing.length)
    throw new EngineError("validation_error", `The timeline uses ${missing.length === 1 ? "a file" : `${missing.length} files`} that ${missing.length === 1 ? "is" : "are"} not ready in this project: ${missing.slice(0, 5).join(", ")}.`);
}
