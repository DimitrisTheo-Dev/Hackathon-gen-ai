// Pure pieces of the machines gateway: who is calling, CORS, and reading a run's event stream.
// No Cloudflare APIs here, so the root test suite covers this file.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** A Supabase user UUID, or a short slug for a personal token. */
export const isUserId = (value: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
export const isProjectId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(value);

const encoder = new TextEncoder();
function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}
const sameText = (a: string, b: string) => {
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
};

/** Personal token for one user: fgw1.<uid>.<HMAC-SHA256(secret, "fgw1:<uid>")>. */
export async function mintGatewayToken(secret: string, uid: string): Promise<string> {
  if (!secret || secret.length < 32) throw new Error("GATEWAY_SIGNING_KEY must be at least 32 characters.");
  if (!isUserId(uid)) throw new Error("User ids are lowercase letters, digits and dashes.");
  return `fgw1.${uid}.${await sign(secret, `fgw1:${uid}`)}`;
}
export async function verifyGatewayToken(secret: string | undefined, token: string): Promise<string | null> {
  const match = /^fgw1\.([a-z0-9][a-z0-9-]{0,63})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || !secret || secret.length < 32) return null;
  return sameText(await sign(secret, `fgw1:${match[1]}`), match[2]) ? match[1] : null;
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
  if (match[1].startsWith("fgw1.")) {
    const uid = await verifyGatewayToken(deps.signingKey, match[1]);
    return uid ? { uid, via: "token" } : null;
  }
  const uid = await deps.verifySession(match[1]);
  return uid ? { uid, via: "session" } : null;
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
