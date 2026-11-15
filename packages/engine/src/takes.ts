import {
  abortTakeInputSchema,
  completeTakeInputSchema,
  startTakeInputSchema,
  TAKE_MAX_PARTS,
  TAKE_PART_BYTES,
  takePartInputSchema,
  takePartUrlSchema,
  takeUploadSchema,
  type DraftFile,
  type TakePartUrl,
  type TakeUpload,
} from "../../contracts/src/index.js";
import { audit, idempotent, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";
import { assertUploadAllowed, fileContract, fileScope, filesOf, FILES_TABLE, nextVersion } from "./files.js";
import { selectOne, type Row } from "./store.js";
import { parse } from "./studio.js";

/**
 * Recorded takes: a voice or camera recording from the New project flow, streamed to storage in parts while
 * the person is still speaking, so it is stored a moment after they stop. Each part link signs the part's exact
 * size. The finished take becomes an ordinary draft file of the project (kind `voice` or `avatar_clip`).
 *
 * Unlike other draft files the key is not the content's hash (the hash is only known at the end), and the
 * whole-file SHA-256 is the one the browser computed over the bytes it uploaded; `meta.sha256` says so.
 */
const PART_URL_TTL_SECONDS = 15 * 60;
/** What a take may grow to: the most parts at the fixed part size. Reserved against the quota when it starts. */
const TAKE_RESERVED_BYTES = 64 * 1024 * 1024;
const PENDING_SHA = "0".repeat(64);
const EXTENSION: Record<string, string> = { "audio/webm": "weba", "audio/mp4": "m4a", "audio/ogg": "ogg", "video/webm": "webm", "video/mp4": "mp4" };

async function pendingTake(deps: EngineDeps, ctx: Ctx, fileId: string) {
  const row = await selectOne(deps.store, FILES_TABLE, { id: fileId, org_id: ctx.org.id });
  if (!row || row.state === "archived") throw new EngineError("not_found", "This recording was not found in your workspace.");
  const uploadId = typeof row.meta?.upload_id === "string" ? row.meta.upload_id : null;
  return { row, uploadId };
}

export async function startTake(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<TakeUpload> {
  requireScope(ctx, "content:edit");
  const input = parse(startTakeInputSchema, raw);
  return idempotent(deps, ctx, "start_take_upload", input.operationKey, input, async () => {
    const project = await fileScope(deps, ctx, input.campaignId, input.itemId);
    await assertUploadAllowed(deps, ctx.org.id, TAKE_RESERVED_BYTES, { draftFile: true });
    const id = crypto.randomUUID();
    const key = `orgs/${ctx.org.id}/projects/${project.id}/takes/${id}.${EXTENSION[input.mime] ?? "bin"}`;
    const uploadId = await filesOf(deps).createMultipart(key, input.mime);
    const now = deps.now().toISOString();
    await deps.store.insert(FILES_TABLE, {
      id,
      org_id: ctx.org.id,
      project_id: project.id,
      item_id: input.itemId,
      kind: input.kind,
      name: input.name,
      mime: input.mime,
      // Reserved until the take is finished, so the storage quota counts a recording in progress.
      bytes: TAKE_RESERVED_BYTES,
      sha256: PENDING_SHA,
      duration_seconds: null,
      meta: { source: "recorded in the studio", upload: "multipart", upload_id: uploadId },
      state: "pending",
      version: await nextVersion(deps, ctx, project.id, input.itemId, input.name),
      storage_key: key,
      created_by: ctx.actorLabel,
      actor_id: ctx.actorId,
      created_at: now,
      updated_at: now,
    });
    return parse(takeUploadSchema, { fileId: id, partBytes: TAKE_PART_BYTES, maxParts: TAKE_MAX_PARTS });
  });
}

/** One part's link. Asking again for the same part is allowed: a retried part simply replaces the earlier one. */
export async function takePartUrl(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<TakePartUrl> {
  requireScope(ctx, "content:edit");
  const input = parse(takePartInputSchema, raw);
  const { row, uploadId } = await pendingTake(deps, ctx, input.fileId);
  if (row.state !== "pending" || !uploadId) throw new EngineError("validation_error", "This recording is already finished.");
  const link = await filesOf(deps).partUrl(row.storage_key, uploadId, { partNumber: input.partNumber, bytes: input.bytes, expiresSeconds: PART_URL_TTL_SECONDS });
  return parse(takePartUrlSchema, link);
}

export async function completeTake(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<DraftFile> {
  requireScope(ctx, "content:edit");
  const input = parse(completeTakeInputSchema, raw);
  return idempotent(deps, ctx, "complete_take_upload", input.operationKey, input, async () => {
    const { row, uploadId } = await pendingTake(deps, ctx, input.fileId);
    if (row.state === "ready") return fileContract(deps, row);
    if (!uploadId) throw new EngineError("validation_error", "This file was not started as a recording.");
    const numbers = input.parts.map((part) => part.partNumber).sort((a, b) => a - b);
    if (numbers.some((number, index) => number !== index + 1)) throw new EngineError("validation_error", "The recording is missing a part. Record again.");
    const files = filesOf(deps);
    await files.completeMultipart(row.storage_key, uploadId, input.parts);
    const stored = await files.head(row.storage_key);
    if (!stored || stored.bytes !== input.bytes) throw new EngineError("validation_error", "The stored recording’s size does not match what was sent. Record again.");
    const meta: Row["meta"] = { source: "recorded in the studio", upload: "multipart", sha256: "computed by the browser" };
    const updated = await deps.store.update(
      FILES_TABLE,
      { id: row.id, org_id: ctx.org.id, state: "pending" },
      { state: "ready", bytes: input.bytes, sha256: input.sha256, duration_seconds: input.durationSeconds, meta, updated_at: deps.now().toISOString() },
    );
    const final = updated[0] ?? (await selectOne(deps.store, FILES_TABLE, { id: row.id, org_id: ctx.org.id }))!;
    await audit(deps, ctx, { projectId: row.project_id, action: `Recorded ${row.name}`, objectId: row.id, revision: row.version, outcome: row.kind });
    return fileContract(deps, final);
  });
}

/** Cancels a recording in progress: its parts are dropped and the file is archived. */
export async function abortTake(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<{ aborted: true }> {
  requireScope(ctx, "content:edit");
  const input = parse(abortTakeInputSchema, raw);
  const { row, uploadId } = await pendingTake(deps, ctx, input.fileId);
  if (row.state !== "pending") return { aborted: true };
  if (uploadId) await filesOf(deps).abortMultipart(row.storage_key, uploadId);
  await deps.store.update(FILES_TABLE, { id: row.id, org_id: ctx.org.id, state: "pending" }, { state: "archived", bytes: 0, updated_at: deps.now().toISOString() });
  return { aborted: true };
}
