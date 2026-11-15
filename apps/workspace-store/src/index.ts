// Faceful workspace store: the only way into the faceful-workspaces R2 bucket.
// Each user's machine holds a token that opens users/<uid>/ and nothing else.
// R2 keys never leave Cloudflare; the Worker reaches the bucket through its binding.

export type StoredObject = { key: string; size: number; uploaded: Date; httpEtag: string; customMetadata?: Record<string, string> };
export type StoredBody = StoredObject & { body: ReadableStream; httpMetadata?: { contentType?: string } };
export interface StoreBucket {
  get(key: string): Promise<StoredBody | null>;
  head(key: string): Promise<StoredObject | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | null, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number; include?: ("httpMetadata" | "customMetadata")[] }): Promise<{ objects: StoredObject[]; truncated: boolean; cursor?: string }>;
}
export type Env = { BUCKET: StoreBucket; STORE_SIGNING_KEY: string };

export const MAX_OBJECT_BYTES = 95 * 1024 * 1024; // Workers accept request bodies up to 100 MB
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

/** A user id is a Supabase user UUID or a short slug. */
export const isUserId = (value: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);

/** Token for one user's machine: fst1.<uid>.<HMAC-SHA256(secret, "fst1:<uid>")>. */
export async function mintToken(secret: string, uid: string): Promise<string> {
  if (!secret || secret.length < 32) throw new Error("STORE_SIGNING_KEY must be at least 32 characters.");
  if (!isUserId(uid)) throw new Error("User ids are lowercase letters, digits and dashes.");
  return `fst1.${uid}.${await sign(secret, `fst1:${uid}`)}`;
}

export async function verifyToken(secret: string, authorization: string | null): Promise<string | null> {
  const match = /^Bearer fst1\.([a-z0-9][a-z0-9-]{0,63})\.([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  if (!match || !secret || secret.length < 32) return null;
  const expected = await sign(secret, `fst1:${match[1]}`);
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ match[2].charCodeAt(index);
  return difference === 0 ? match[1] : null;
}

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
  const uid = await verifyToken(env.STORE_SIGNING_KEY, request.headers.get("authorization"));
  if (!uid) return problem(401, "unauthorized", "Missing or invalid store token.");
  const root = `users/${uid}/`;

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
