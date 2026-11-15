// Pure pieces of the machines gateway: who is calling, CORS, and reading a run's event stream.
// No Cloudflare APIs here, so the root test suite covers this file.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { mintSignedToken, parseKeyring, verifySignedToken } from "../../workspace-store/src/signed-token";

/** A Supabase user UUID, or a short slug for a personal token. */
export const isUserId = (value: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
export const isProjectId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(value);

export const GATEWAY_AUDIENCE = "faceful-machines";
/** Personal tokens (mint-token.mjs), signed with GATEWAY_SIGNING_KEY. They expire; rotating the key revokes them all. */
export const PERSONAL_TOKEN = { kind: "fgw2", maxTtlSeconds: 30 * 86_400 } as const;
export async function mintGatewayToken(signingKey: string, uid: string, ttlSeconds: number, now = Date.now()): Promise<string> {
  const keyring = parseKeyring(signingKey);
  if (!keyring) throw new Error("GATEWAY_SIGNING_KEY must be at least 32 characters, or a keyring like 2:<secret>,1:<older secret>.");
  if (ttlSeconds > PERSONAL_TOKEN.maxTtlSeconds) throw new Error("Personal tokens live 30 days at most.");
  return mintSignedToken(keyring, PERSONAL_TOKEN.kind, GATEWAY_AUDIENCE, uid, ttlSeconds, now);
}
export async function verifyGatewayToken(signingKey: string | undefined, token: string, now = Date.now()): Promise<string | null> {
  return (await verifySignedToken(parseKeyring(signingKey), PERSONAL_TOKEN.kind, GATEWAY_AUDIENCE, token, PERSONAL_TOKEN.maxTtlSeconds, now))?.uid ?? null;
}

/** Verifies a Faceful (Supabase) session against the project's public signing keys. No secret needed. */
export function createSessionVerifier(supabaseUrl: string, keys?: JWTVerifyGetKey) {
  const issuer = `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
  const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  return async (token: string): Promise<string | null> => {
    try {
      // Signature, issuer, audience and expiry are all checked; asymmetric algorithms only.
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: "authenticated", algorithms: ["ES256", "RS256"] });
      if (typeof payload.sub !== "string" || payload.role !== "authenticated" || payload.is_anonymous === true) return null;
      // Tokens issued to an external agent (OAuth client) don't get a machine; first-party sessions do.
      if (typeof payload.client_id === "string" && payload.client_id) return null;
      const uid = payload.sub.toLowerCase();
      return isUserId(uid) ? uid : null;
    } catch { return null; }
  };
}

export type Identity = { uid: string; via: "token" | "session" };
export async function identify(authorization: string | null, deps: { signingKey?: string; verifySession: (token: string) => Promise<string | null> }): Promise<Identity | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match) return null;
  if (/^fgw\d\./.test(match[1])) {
    const uid = await verifyGatewayToken(deps.signingKey, match[1]);
    return uid ? { uid, via: "token" } : null;
  }
  const uid = await deps.verifySession(match[1]);
  return uid ? { uid, via: "session" } : null;
}

/** MACHINE_ALLOWED_USERS: the user ids (Supabase UUIDs or personal-token slugs) that may have a machine. Empty lets nobody in. */
export const parseAllowlist = (value: string | undefined) => new Set((value ?? "").split(",").map((id) => id.trim().toLowerCase()).filter(isUserId));
export const NOT_ENABLED = "Cloud machines are invite-only for now. Ask the Faceful team to turn one on for your account.";

// ---------- per-user limits (D1 machine_wakes: one row per wake) ----------

export type MachineLimits = { wakesPerHour: number; awakeMinutesPerDay: number };
const whole = (value: string | undefined, fallback: number, max: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : fallback;
};
export const limitsFrom = (env: { MACHINE_WAKES_PER_HOUR?: string; MACHINE_AWAKE_MINUTES_PER_DAY?: string }): MachineLimits => ({
  wakesPerHour: whole(env.MACHINE_WAKES_PER_HOUR, 6, 1000),
  awakeMinutesPerDay: whole(env.MACHINE_AWAKE_MINUTES_PER_DAY, 240, 1440),
});

export type Wake = { started_at: string; stopped_at: string | null };
const HOUR = 3_600_000;
const startOfDay = (now: number) => { const day = new Date(now); return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()); };
/** The oldest moment a wake row can matter to `machineUsage`: rows that stopped before it are left out of the query. */
export const usageSince = (now: number) => new Date(Math.min(startOfDay(now), now - HOUR)).toISOString();
/** The statements behind the limits, here so the tests run them against schema.sql. */
export const WAKE_SQL = {
  usage: "select started_at, stopped_at from machine_wakes where user_id = ? and (stopped_at is null or stopped_at > ?) order by started_at desc limit 500",
  close: "update machine_wakes set stopped_at = ? where user_id = ? and stopped_at is null",
  open: "insert into machine_wakes (user_id, started_at) values (?, ?)",
  prune: "delete from machine_wakes where user_id = ? and stopped_at < ?",
};
/** Wakes in the last hour, and minutes awake since 00:00 UTC. An open row (still awake) counts until now. */
export function machineUsage(wakes: Wake[], now: number) {
  const today = startOfDay(now);
  let wakesLastHour = 0;
  let oldestWake = now;
  let awakeMs = 0;
  for (const wake of wakes) {
    const started = Date.parse(wake.started_at);
    if (!Number.isFinite(started)) continue;
    const stopped = wake.stopped_at ? Math.min(Date.parse(wake.stopped_at), now) : now;
    if (started > now - HOUR) { wakesLastHour++; oldestWake = Math.min(oldestWake, started); }
    awakeMs += Math.max(0, stopped - Math.max(started, today));
  }
  return { wakesLastHour, oldestWake, awakeMinutesToday: awakeMs / 60_000, resetsAt: today + 24 * HOUR };
}
export type LimitProblem = { code: "wake_limit" | "daily_limit"; message: string; retryAfterSeconds: number };
const inWords = (seconds: number) => {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};
/** Why this user's machine may not wake (`waking`) or keep working, or null. */
export function limitProblem(usage: ReturnType<typeof machineUsage>, limits: MachineLimits, now: number, { waking }: { waking: boolean }): LimitProblem | null {
  if (usage.awakeMinutesToday >= limits.awakeMinutesPerDay) {
    const retryAfterSeconds = Math.ceil((usage.resetsAt - now) / 1000);
    return { code: "daily_limit", retryAfterSeconds, message: `Your machine has been awake for ${limits.awakeMinutesPerDay} minutes today, the daily limit. It can wake again at 00:00 UTC, in ${inWords(retryAfterSeconds)}.` };
  }
  if (waking && usage.wakesLastHour >= limits.wakesPerHour) {
    const retryAfterSeconds = Math.ceil((usage.oldestWake + HOUR - now) / 1000);
    return { code: "wake_limit", retryAfterSeconds, message: `Your machine has woken ${limits.wakesPerHour} times in the last hour, the most it can. It can wake again in ${inWords(retryAfterSeconds)}.` };
  }
  return null;
}

export const parseOrigins = (value: string | undefined) => (value ?? "").split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean);
export function corsFor(origin: string | null, allowed: string[]): Record<string, string> | null {
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export type SaveRecord = { key: string; project: string; kind: "auto" | "manual"; bytes: number; files: number; sha256: string; savedAt: string };
export function asSaveRecord(value: unknown): SaveRecord | null {
  const save = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (typeof save.key !== "string" || typeof save.project !== "string" || !isProjectId(save.project)) return null;
  if (!save.key.startsWith(`projects/${save.project}/`) || save.key.length > 512) return null;
  if (save.kind !== "auto" && save.kind !== "manual") return null;
  if (typeof save.bytes !== "number" || typeof save.files !== "number" || typeof save.sha256 !== "string" || typeof save.savedAt !== "string") return null;
  return { key: save.key, project: save.project, kind: save.kind, bytes: save.bytes, files: save.files, sha256: save.sha256, savedAt: save.savedAt };
}

export type RunEvent = { kind: "saved"; save: SaveRecord } | { kind: "result"; sessionId: string };
/** Picks out the two events the database cares about from one NDJSON line of a run. */
export function parseRunEvent(line: string): RunEvent | null {
  if (!line.includes('"saved"') && !line.includes('"result"')) return null;
  let event: Record<string, unknown>;
  try { event = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (event?.type === "runner" && event.event === "saved") {
    const save = asSaveRecord(event.save);
    return save ? { kind: "saved", save } : null;
  }
  if (event?.type === "result" && typeof event.session_id === "string" && /^[0-9a-f-]{36}$/i.test(event.session_id)) return { kind: "result", sessionId: event.session_id };
  return null;
}

/** Passes bytes through untouched while handing each complete line to `onLine`. */
export function createLineScanner(onLine: (line: string) => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = (line: string) => { if (line.trim()) try { onLine(line); } catch { /* a bad line never breaks the stream */ } };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        emit(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (buffer.length > 4_000_000) buffer = ""; // a single enormous line is not one of ours
    },
    flush() { emit(buffer + decoder.decode()); },
  });
}

export const slugify = (title: string) => title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
