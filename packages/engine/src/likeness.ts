import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  LIKENESS_MAX_STILL_BYTES,
  LIKENESS_MAX_VIDEO_BYTES,
  likenessConsentInputSchema,
  likenessConsentResultSchema,
  likenessConsentStatement,
  likenessLiveTokenSchema,
  likenessPoseSchema,
  likenessUploadInputSchema,
  likenessUploadTicketSchema,
  type LikenessPose,
} from "../../contracts/src/index.js";
import { audit, requireHuman, type Ctx, type EngineDeps } from "./access.js";
import { EngineError, deny } from "./errors.js";
import { UnconfiguredFileStore, type FileStore } from "./r2.js";
import { selectOne } from "./store.js";
import { parse } from "./studio.js";

/**
 * Likeness consents: the proof that a person agreed to have their face and voice turned into an avatar
 * (the "Scan my face" capture, apps/web/src/likeness).
 *
 * The browser records a guided face scan and three phrases read aloud, then sends each recording straight
 * to private R2 through a link that accepts exactly that file (its SHA-256 is part of the signature). The
 * consent row holds object keys, never URLs. A face and a voice are biometric data, so:
 *   • only a signed-in person can record or withdraw a consent, never an agent on their behalf;
 *   • a consent can only name recordings that the same person uploaded into the same workspace;
 *   • the stored sentence is rebuilt here from the name, so its wording is always ours;
 *   • withdrawing deletes the recordings and keeps the row as the record that consent was withdrawn.
 * The liveness checks are computed in the browser. They are kept as evidence, not treated as verified.
 */
export const LIKENESS_TABLE = "likeness_consents";
const UPLOAD_TTL_SECONDS = 10 * 60;
/** Humanlike accepts a token for at most 120 seconds by its own clock; 90 leaves room for clock skew. */
const LIVE_TOKEN_SECONDS = 90;
/**
 * Each token opens one paid transcription stream, so a workspace gets a bounded number per hour. A capture
 * uses two: a half-second health check during the scan, then the stream for the read-aloud.
 */
const LIVE_TOKENS_PER_HOUR = 60;
const LIVE_TOKEN_ACTION = "Opened live transcription for a face scan";
const EXTENSIONS = { "video/mp4": "mp4", "video/webm": "webm", "video/x-matroska": "mkv", "image/jpeg": "jpg" } as const;
const VIDEO = "mp4|webm|mkv";
const POSES = likenessPoseSchema.options;

const filesOf = (deps: EngineDeps): FileStore => deps.files ?? new UnconfiguredFileStore();
function storage(deps: EngineDeps): FileStore {
  const files = filesOf(deps);
  if (!files.configured) throw new EngineError("provider_unavailable", "Private file storage isn’t connected on this deployment yet, so a face scan can’t be saved. Add the FACEFUL_R2_* settings.");
  return files;
}
/** The signed-in person's id. A likeness is the person's own to give, so agents are refused whatever their scopes. */
function person(ctx: Ctx, action: string): string {
  requireHuman(ctx, action);
  return (ctx.principal as { userId: string }).userId;
}
/** Everything one person recorded in one workspace. No key under it can be reached from another workspace or member. */
export const likenessFolder = (orgId: string, userId: string) => `orgs/${orgId}/likeness/${userId}/`;
const ownsKey = (folder: string, key: unknown, extensions: string): key is string =>
  typeof key === "string" && key.startsWith(folder) && new RegExp(`^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.(?:${extensions})$`).test(key.slice(folder.length));

/** POST /v1/studio/likeness/upload-url: a link that accepts one recording or still, and nothing else. */
export async function likenessUploadUrl(deps: EngineDeps, ctx: Ctx, raw: unknown) {
  const userId = person(ctx, "Recording a face scan");
  const input = parse(likenessUploadInputSchema, raw);
  if (input.type === "image/jpeg" && input.size > LIKENESS_MAX_STILL_BYTES) throw new EngineError("validation_error", "That still is too large to save.");
  const files = storage(deps);
  const key = `${likenessFolder(ctx.org.id, userId)}${crypto.randomUUID()}.${EXTENSIONS[input.type]}`;
  const { url, headers } = await files.uploadUrl(key, { sha256Hex: input.sha256, contentType: input.type, expiresSeconds: UPLOAD_TTL_SECONDS });
  return parse(likenessUploadTicketSchema, { key, uploadUrl: url, headers, expiresAt: new Date(deps.now().getTime() + UPLOAD_TTL_SECONDS * 1000).toISOString() });
}

/**
 * POST /v1/studio/likeness/live-token: a single-use token for Humanlike's live transcription socket, which
 * follows the person as they read. The token is `${exp}.${nonce}.${sig}` with
 * sig = base64url HMAC-SHA256(key, `transcribe-live.${exp}.${nonce}`); the key itself never leaves the engine.
 */
export async function likenessLiveToken(deps: EngineDeps, ctx: Ctx) {
  person(ctx, "Live transcription");
  const key = deps.config.humanlikeTranscribeKey;
  if (!key) throw new EngineError("provider_unavailable", "Live transcription isn’t connected on this deployment. The face scan follows your voice with the browser’s own speech recognition instead.");
  const since = new Date(deps.now().getTime() - 3600_000).toISOString();
  const recent = await deps.store.select("audit_events", { org_id: ctx.org.id, action: LIVE_TOKEN_ACTION, at: { gte: since } }, { limit: LIVE_TOKENS_PER_HOUR + 1 });
  if (recent.length >= LIVE_TOKENS_PER_HOUR)
    throw new EngineError("quota_exceeded", "This workspace has started too many face scans in the last hour. Try again later.", { retryAfterSeconds: 600 });
  const exp = Math.floor(deps.now().getTime() / 1000) + LIVE_TOKEN_SECONDS;
  const nonce = randomBytes(16).toString("base64url");
  const signature = createHmac("sha256", key).update(`transcribe-live.${exp}.${nonce}`).digest("base64url");
  await audit(deps, ctx, { action: LIVE_TOKEN_ACTION, objectId: nonce, outcome: "A single-use token was issued" });
  return parse(likenessLiveTokenSchema, { token: `${exp}.${nonce}.${signature}`, url: `${deps.config.humanlikeApiUrl.replace(/^http/, "ws")}/transcribe/live`, expiresInSeconds: LIVE_TOKEN_SECONDS });
}

/**
 * POST /v1/studio/likeness/consents: saves the proof once the browser has uploaded the recordings. A manifest
 * (who, when, from where, what was said, the checks) is written next to them.
 */
export async function saveLikenessConsent(deps: EngineDeps, ctx: Ctx, raw: unknown, client: { userAgent: string | null; ipAddress: string | null }) {
  const userId = person(ctx, "Giving consent for an avatar");
  const input = parse(likenessConsentInputSchema, raw);
  const statement = likenessConsentStatement(input.subjectName, input.language);
  if (input.phrases[2] !== statement) throw new EngineError("validation_error", "The consent statement does not match the name given. Scan again.");

  const folder = likenessFolder(ctx.org.id, userId);
  const stills: Partial<Record<LikenessPose, string>> = {};
  for (const pose of POSES) {
    const key = input.stills[pose];
    if (ownsKey(folder, key, "jpg")) stills[pose] = key;
  }
  if (!ownsKey(folder, input.scanVideoKey, VIDEO) || !ownsKey(folder, input.speechVideoKey, VIDEO) || !stills.center)
    throw new EngineError("validation_error", "The recordings are missing. Scan again.");
  const files = storage(deps);
  const recordings: Array<[key: string, limit: number]> = [[input.scanVideoKey, LIKENESS_MAX_VIDEO_BYTES], [input.speechVideoKey, LIKENESS_MAX_VIDEO_BYTES], ...Object.values(stills).map((key): [string, number] => [key, LIKENESS_MAX_STILL_BYTES])];
  const discard = () => Promise.all(recordings.map(([key]) => files.remove(key).catch(() => undefined)));

  // Storage already refused any bytes that did not match the declared SHA-256; existence and size close the loop.
  const found = await Promise.all(recordings.map(([key]) => files.head(key)));
  if (found.some((object) => !object)) throw new EngineError("validation_error", "A recording did not finish uploading. Save again.");
  const passed = input.report.passed && input.report.checks.every((check) => check.passed || !check.required);
  if (!passed || found.some((object, i) => object!.bytes > recordings[i][1])) {
    // Nothing that will not be kept as a consent stays in storage.
    await discard();
    throw new EngineError("validation_error", passed ? "A recording is too large to save. Scan again." : "This capture did not pass its checks, so it was not saved. Scan again.");
  }

  const id = crypto.randomUUID();
  const createdAt = deps.now().toISOString();
  const checks = { passed, checks: input.report.checks };
  const email = ctx.principal.kind === "human" ? ctx.principal.email : null;
  let manifestKey: string | null = `${folder}${crypto.randomUUID()}.json`;
  try {
    const manifest = {
      version: 1,
      id,
      created_at: createdAt,
      org_id: ctx.org.id,
      user_id: userId,
      email,
      subject_name: input.subjectName,
      language: input.language,
      statement,
      phrases: input.phrases,
      transcript: input.transcript,
      files: { scan_video: input.scanVideoKey, speech_video: input.speechVideoKey, stills },
      liveness: checks,
      user_agent: client.userAgent,
      ip_address: client.ipAddress,
    };
    await files.put(manifestKey, new TextEncoder().encode(JSON.stringify(manifest, null, 2)), "application/json");
  } catch {
    // The row below holds the same facts; a missing manifest must not lose a consent the person just gave.
    console.error(JSON.stringify({ level: "error", event: "likeness_manifest_failed", correlationId: ctx.correlationId }));
    manifestKey = null;
  }
  await deps.store.insert(LIKENESS_TABLE, {
    id,
    org_id: ctx.org.id,
    user_id: userId,
    subject_name: input.subjectName,
    language: input.language,
    statement,
    phrases: input.phrases,
    transcript: input.transcript,
    scan_video_key: input.scanVideoKey,
    speech_video_key: input.speechVideoKey,
    stills,
    manifest_key: manifestKey,
    checks,
    passed,
    user_agent: client.userAgent,
    ip_address: client.ipAddress,
    created_at: createdAt,
    revoked_at: null,
  });
  await audit(deps, ctx, { action: "Recorded a face scan and spoken consent", objectId: id, outcome: `Saved privately with ${Object.keys(stills).length} stills` });
  return parse(likenessConsentResultSchema, { id, passed });
}

/**
 * DELETE /v1/studio/likeness/consents/:id: the person who recorded it, or a workspace owner or admin,
 * withdraws it. The recordings are deleted first; the row stays, emptied of keys, as the record of withdrawal.
 */
export async function revokeLikenessConsent(deps: EngineDeps, ctx: Ctx, consentId: string) {
  const userId = person(ctx, "Withdrawing a consent");
  const row = z.uuid().safeParse(consentId).success ? await selectOne(deps.store, LIKENESS_TABLE, { id: consentId, org_id: ctx.org.id }) : null;
  if (!row) deny("This consent was not found in your workspace.");
  if (row.user_id !== userId && ctx.role !== "owner" && ctx.role !== "admin")
    throw new EngineError("forbidden", "Only the person who recorded this, or a workspace owner or admin, can withdraw it.");
  if (row.revoked_at) return { revoked: true as const };
  const keys = [row.scan_video_key, row.speech_video_key, row.manifest_key, ...Object.values((row.stills ?? {}) as Record<string, string>)].filter((key): key is string => typeof key === "string" && key.length > 0);
  // A failed delete stops here, so the row keeps its keys and withdrawing again finishes the job.
  if (keys.length) {
    const files = storage(deps);
    await Promise.all(keys.map((key) => files.remove(key)));
  }
  await deps.store.update(LIKENESS_TABLE, { id: row.id, org_id: ctx.org.id }, { revoked_at: deps.now().toISOString(), scan_video_key: null, speech_video_key: null, manifest_key: null, stills: {} });
  await audit(deps, ctx, { action: "Withdrew a face scan consent", objectId: row.id, outcome: `${keys.length} private files deleted` });
  return { revoked: true as const };
}
