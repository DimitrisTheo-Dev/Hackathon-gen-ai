import { createHash, createHmac } from "node:crypto";
import { EngineError } from "./errors.js";

/**
 * Draft-file storage on Cloudflare R2 through its S3 API, signed here with AWS Signature V4
 * (query-string presigning). No SDK: one small signer, testable against AWS's published vector.
 * Browsers, agents and render workers only ever receive short-lived URLs for one object.
 */
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface FileStore {
  readonly configured: boolean;
  /** URL a client PUTs one object to. R2 rejects the body unless it matches the declared SHA-256. */
  uploadUrl(key: string, options: { sha256Hex: string; contentType: string; expiresSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>;
  downloadUrl(key: string, expiresSeconds: number, filename?: string): Promise<string>;
  head(key: string): Promise<{ bytes: number; contentType: string } | null>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Deletes one object. Deleting an object that is already gone succeeds. */
  remove(key: string): Promise<void>;
}

const UNRESERVED = /[A-Za-z0-9\-_.~]/;
/** RFC 3986 encoding as SigV4 requires: everything but unreserved characters, `/` kept in paths. */
export function encodeRfc3986(value: string, keepSlash = false) {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    out += UNRESERVED.test(char) || (keepSlash && char === "/") ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}
const sha256Hex = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
export function amzDate(now: Date) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** SigV4 query presigning for any S3-compatible host. Signed headers beyond `host` must be sent verbatim. */
export function presignUrl(input: {
  method: string;
  host: string;
  path: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
  expiresSeconds: number;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}) {
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: input.host };
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value.trim();
  const signedHeaders = Object.keys(headers).sort().join(";");
  const query: Record<string, string> = {
    ...input.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": date,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key])}`)
    .join("&");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const path = encodeRfc3986(input.path, true);
  const canonicalRequest = [input.method, path, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `https://${input.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Object keys are built by the engine only; this guards against a bug ever producing a path escape. */
function assertKey(key: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/.test(key) || key.includes("..") || key.includes("//"))
    throw new EngineError("validation_error", "That file location is not valid.");
}

export class R2FileStore implements FileStore {
  readonly configured = true;
  constructor(
    private readonly config: R2Config,
    private readonly now: () => Date,
    private readonly fetcher: typeof fetch,
  ) {}
  private sign(method: string, key: string, expiresSeconds: number, headers: Record<string, string> = {}, query: Record<string, string> = {}) {
    assertKey(key);
    return presignUrl({
      method,
      host: `${this.config.accountId}.r2.cloudflarestorage.com`,
      path: `/${this.config.bucket}/${key}`,
      region: "auto",
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      now: this.now(),
      expiresSeconds,
      headers,
      query,
    });
  }
  async uploadUrl(key: string, options: { sha256Hex: string; contentType: string; expiresSeconds: number }) {
    const headers = { "content-type": options.contentType, "x-amz-checksum-sha256": Buffer.from(options.sha256Hex, "hex").toString("base64") };
    return { url: this.sign("PUT", key, options.expiresSeconds, headers), headers };
  }
  async downloadUrl(key: string, expiresSeconds: number, filename?: string) {
    const query: Record<string, string> = filename ? { "response-content-disposition": `inline; filename="${filename.replace(/[^A-Za-z0-9._ -]/g, "_")}"` } : {};
    return this.sign("GET", key, expiresSeconds, {}, query);
  }
  async head(key: string) {
    // Without this, R2 answers for a compressible type (JSON, text) gzip-encoded and with no Content-Length,
    // and the size reads as 0.
    const response = await this.fetcher(this.sign("HEAD", key, 60), { method: "HEAD", headers: { "accept-encoding": "identity" } });
    if (response.status === 404) return null;
    if (!response.ok) throw new EngineError("provider_unavailable", "File storage could not be reached. Nothing was changed; try again.");
    return { bytes: Number(response.headers.get("content-length") ?? 0), contentType: response.headers.get("content-type") ?? "application/octet-stream" };
  }
  async put(key: string, bytes: Uint8Array, contentType: string) {
    const sha = createHash("sha256").update(bytes).digest("hex");
    const { url, headers } = await this.uploadUrl(key, { sha256Hex: sha, contentType, expiresSeconds: 60 });
    const response = await this.fetcher(url, { method: "PUT", headers, body: new Blob([new Uint8Array(bytes)], { type: contentType }) });
    if (!response.ok) throw new EngineError("provider_unavailable", "File storage could not save the file. Nothing was changed; try again.");
  }
  async remove(key: string) {
    const response = await this.fetcher(this.sign("DELETE", key, 60), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new EngineError("provider_unavailable", "File storage could not delete the file. Try again.");
  }
}

/** Placeholder when R2 is not configured: every call explains what is missing instead of failing silently. */
export class UnconfiguredFileStore implements FileStore {
  readonly configured = false;
  private fail(): never {
    throw new EngineError("provider_unavailable", "Draft file storage isn’t connected on this deployment yet. Add the FACEFUL_R2_* settings to enable uploads.");
  }
  async uploadUrl(): Promise<never> { return this.fail(); }
  async downloadUrl(): Promise<never> { return this.fail(); }
  async head(): Promise<never> { return this.fail(); }
  async put(): Promise<never> { return this.fail(); }
  async remove(): Promise<never> { return this.fail(); }
}

/** Test store: objects in memory, URLs that name the object and the declared checksum. */
export class MemoryFileStore implements FileStore {
  readonly configured = true;
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async uploadUrl(key: string, options: { sha256Hex: string; contentType: string }) {
    assertKey(key);
    return { url: `https://files.test/upload/${key}`, headers: { "content-type": options.contentType, "x-amz-checksum-sha256": Buffer.from(options.sha256Hex, "hex").toString("base64") } };
  }
  async downloadUrl(key: string, expiresSeconds: number) {
    assertKey(key);
    return `https://files.test/${key}?ttl=${expiresSeconds}`;
  }
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { bytes: object.bytes.byteLength, contentType: object.contentType } : null;
  }
  async put(key: string, bytes: Uint8Array, contentType: string) {
    assertKey(key);
    this.objects.set(key, { bytes, contentType });
  }
  async remove(key: string) {
    assertKey(key);
    this.objects.delete(key);
  }
}
