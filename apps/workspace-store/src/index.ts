// Faceful workspace store: the only way into the faceful-workspaces R2 bucket.
// Each user's machine holds a token that opens users/<uid>/ and nothing else, for a limited time.
// R2 keys never leave Cloudflare; the Worker reaches the bucket through its binding.
import { isUserId, mintSignedToken, parseKeyring, verifySignedToken, type TokenClaims } from "./signed-token";

export type StoredObject = { key: string; size: number; uploaded: Date; httpEtag: string; customMetadata?: Record<string, string> };
export type StoredBody = StoredObject & { body: ReadableStream; httpMetadata?: { contentType?: string } };
export interface StoreBucket {
  get(key: string): Promise<StoredBody | null>;
  head(key: string): Promise<StoredObject | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | null, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number; include?: ("httpMetadata" | "customMetadata")[] }): Promise<{ objects: StoredObject[]; truncated: boolean; cursor?: string }>;
}
/** STORE_SIGNING_KEY is a keyring (signed-token.ts): a bare secret, or "2:<new>,1:<old>" while rotating. */
export type Env = { BUCKET: StoreBucket; STORE_SIGNING_KEY: string };

export const MAX_OBJECT_BYTES = 95 * 1024 * 1024; // Workers accept request bodies up to 100 MB
export { isUserId };

/**
 * Store tokens: fst2.<key version>.<uid>.<issued>.<expires>.<HMAC>. The machines gateway gives each awake machine one
 * for 12 hours and renews it halfway; mint-token.mjs makes longer ones (up to 90 days) for a runner on your own server.
 */
export const STORE_TOKEN = { kind: "fst2", audience: "faceful-workspace-store", maxTtlSeconds: 90 * 86_400 } as const;
export const MACHINE_STORE_TOKEN_TTL = 12 * 3600;
export async function mintToken(signingKey: string, uid: string, ttlSeconds: number = MACHINE_STORE_TOKEN_TTL, now = Date.now()): Promise<string> {
  const keyring = parseKeyring(signingKey);
  if (!keyring) throw new Error("STORE_SIGNING_KEY must be at least 32 characters, or a keyring like 2:<secret>,1:<older secret>.");
  if (ttlSeconds > STORE_TOKEN.maxTtlSeconds) throw new Error("Store tokens live 90 days at most.");
  return mintSignedToken(keyring, STORE_TOKEN.kind, STORE_TOKEN.audience, uid, ttlSeconds, now);
}
export async function verifyToken(signingKey: string, authorization: string | null, now = Date.now()): Promise<TokenClaims | null> {
  const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1] ?? "";
  return verifySignedToken(parseKeyring(signingKey), STORE_TOKEN.kind, STORE_TOKEN.audience, token, STORE_TOKEN.maxTtlSeconds, now);
}
/**
 * Revokes one user's store tokens: any object at this key refuses every token issued before it was written. It sits
 * outside users/, so no token can write or remove it. The next wake mints a new token, so this is for a token that
 * leaked; taking a machine away is MACHINE_ALLOWED_USERS on the gateway.
 */
export const revocationKey = (uid: string) => `revocations/${uid}`;

/** Keys are relative to the user's folder: no leading slash, no empty, "." or ".." segments. */
export function cleanKey(raw: string, { prefix = false } = {}): string | null {
  let key: string;
  try { key = decodeURIComponent(raw); } catch { return null; }
  if (prefix && key === "") return "";
  if (!key || key.length > 512 || !/^[A-Za-z0-9._/-]+$/.test(key)) return null;
  const parts = key.split("/");
  if (prefix && parts.at(-1) === "") parts.pop();
  return parts.every((part) => part !== "" && part !== "." && part !== "..") ? key : null;
}

function metadataFrom(header: string | null): Record<string, string> | null {
  if (!header) return {};
  if (header.length > 2048) return null;
  try {
    const value = JSON.parse(header) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 16 || entries.some(([key, item]) => !/^[a-z0-9_-]{1,40}$/.test(key) || typeof item !== "string" || item.length > 256)) return null;
    return Object.fromEntries(entries) as Record<string, string>;
  } catch { return null; }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const problem = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ ok: true });
  const claims = await verifyToken(env.STORE_SIGNING_KEY, request.headers.get("authorization"));
  if (!claims) return problem(401, "unauthorized", "Missing, expired or invalid store token.");
  const revoked = await env.BUCKET.head(revocationKey(claims.uid));
  if (revoked && claims.issuedAt * 1000 <= revoked.uploaded.getTime()) return problem(401, "token_revoked", "This store token was revoked. A machine gets a new one when it wakes.");
  const root = `users/${claims.uid}/`;

  if (url.pathname === "/v1/objects") {
    if (request.method !== "GET") return problem(405, "method_not_allowed", "List with GET.");
    const prefix = cleanKey(url.searchParams.get("prefix") ?? "", { prefix: true });
    if (prefix === null) return problem(400, "invalid_prefix", "That prefix isn't a valid path.");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 1000);
    // R2 leaves custom metadata out of listings unless asked.
    const listed = await env.BUCKET.list({ prefix: root + prefix, cursor: url.searchParams.get("cursor") ?? undefined, limit, include: ["customMetadata"] });
    return json({
      objects: listed.objects.map((item) => ({ key: item.key.slice(root.length), size: item.size, uploaded: item.uploaded.toISOString(), etag: item.httpEtag, metadata: item.customMetadata ?? {} })),
      cursor: listed.truncated ? listed.cursor ?? null : null,
    });
  }

  const match = /^\/v1\/objects\/(.+)$/.exec(url.pathname);
  if (!match) return problem(404, "not_found", "Unknown endpoint.");
  const key = cleanKey(match[1]);
  if (!key) return problem(400, "invalid_key", "Keys use letters, digits, dot, dash, underscore and slashes, without empty or dot segments.");
  const full = root + key;

  switch (request.method) {
    case "PUT": {
      const length = Number(request.headers.get("content-length"));
      if (!Number.isFinite(length) || length <= 0) return problem(411, "length_required", "Send a Content-Length with a non-empty body.");
      if (length > MAX_OBJECT_BYTES) return problem(413, "too_large", `Objects are limited to ${MAX_OBJECT_BYTES} bytes.`);
      const customMetadata = metadataFrom(request.headers.get("x-store-meta"));
      if (customMetadata === null) return problem(400, "invalid_metadata", "x-store-meta must be a small JSON object of strings.");
      const stored = await env.BUCKET.put(full, request.body, { httpMetadata: { contentType: request.headers.get("content-type") ?? "application/octet-stream" }, customMetadata });
      return json({ key, size: stored?.size ?? length, etag: stored?.httpEtag ?? null }, 201);
    }
    case "GET":
    case "HEAD": {
      const found = request.method === "GET" ? await env.BUCKET.get(full) : await env.BUCKET.head(full);
      if (!found) return problem(404, "not_found", "No object at that key.");
      const headers = { "content-type": (found as StoredBody).httpMetadata?.contentType ?? "application/octet-stream", "content-length": String(found.size), etag: found.httpEtag, "cache-control": "private, no-store" };
      return new Response(request.method === "GET" ? (found as StoredBody).body : null, { headers });
    }
    case "DELETE":
      await env.BUCKET.delete(full);
      return new Response(null, { status: 204 });
    default:
      return problem(405, "method_not_allowed", "Use GET, HEAD, PUT or DELETE.");
  }
}

export default { fetch: handle };
