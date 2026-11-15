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
  /**
   * URL a client PUTs one object to. R2 rejects the body unless it matches the declared SHA-256 and byte size.
   * `headers` are what the client must send; the size is signed but not among them, since fetch sends it itself.
   */
  uploadUrl(key: string, options: { sha256Hex: string; contentType: string; bytes: number; expiresSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>;
  downloadUrl(key: string, expiresSeconds: number, filename?: string): Promise<string>;
  head(key: string): Promise<{ bytes: number; contentType: string } | null>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Deletes one object. Deleting an object that is already gone succeeds. */
  remove(key: string): Promise<void>;
  /** Opens a multipart upload (a recording streamed while it is made) and returns its upload id. */
  createMultipart(key: string, contentType: string): Promise<string>;
  /** URL a client PUTs one part to. The part's size is signed, so a body of any other length is refused. */
  partUrl(key: string, uploadId: string, options: { partNumber: number; bytes: number; expiresSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>;
  completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<void>;
  /** Drops an unfinished multipart upload and its parts. Aborting one that is already gone succeeds. */
  abortMultipart(key: string, uploadId: string): Promise<void>;
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
  async uploadUrl(key: string, options: { sha256Hex: string; contentType: string; bytes: number; expiresSeconds: number }) {
    if (!Number.isSafeInteger(options.bytes) || options.bytes < 0) throw new EngineError("validation_error", "That file size is not valid.");
    const headers = { "content-type": options.contentType, "x-amz-checksum-sha256": Buffer.from(options.sha256Hex, "hex").toString("base64") };
    // The declared size is signed too, so R2 refuses a body of any other length (a checksum alone is checked only
    // after the bytes arrive). It is not handed back: browsers and fetch refuse a script-set Content-Length and send
    // the real one themselves.
    return { url: this.sign("PUT", key, options.expiresSeconds, { ...headers, "content-length": String(options.bytes) }), headers };
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
    const { url, headers } = await this.uploadUrl(key, { sha256Hex: sha, contentType, bytes: bytes.byteLength, expiresSeconds: 60 });
    const response = await this.fetcher(url, { method: "PUT", headers, body: new Blob([new Uint8Array(bytes)], { type: contentType }) });
    if (!response.ok) throw new EngineError("provider_unavailable", "File storage could not save the file. Nothing was changed; try again.");
  }
  async remove(key: string) {
    const response = await this.fetcher(this.sign("DELETE", key, 60), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new EngineError("provider_unavailable", "File storage could not delete the file. Try again.");
  }
  async createMultipart(key: string, contentType: string) {
    const response = await this.fetcher(this.sign("POST", key, 60, { "content-type": contentType }, { uploads: "" }), { method: "POST", headers: { "content-type": contentType } });
    const uploadId = response.ok ? (await response.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1] : undefined;
    if (!uploadId) throw new EngineError("provider_unavailable", "File storage could not start the upload. Nothing was saved; try again.");
    return uploadId;
  }
  async partUrl(key: string, uploadId: string, options: { partNumber: number; bytes: number; expiresSeconds: number }) {
    if (!Number.isSafeInteger(options.bytes) || options.bytes <= 0) throw new EngineError("validation_error", "That part size is not valid.");
    // As with a single upload, the length is signed but not handed back: the browser sends the real one itself.
    const url = this.sign("PUT", key, options.expiresSeconds, { "content-length": String(options.bytes) }, { partNumber: String(options.partNumber), uploadId });
    return { url, headers: {} };
  }
  async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
    const xml = (value: string) => value.replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`);
    const body = `<CompleteMultipartUpload>${[...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xml(part.etag)}</ETag></Part>`)
      .join("")}</CompleteMultipartUpload>`;
    const response = await this.fetcher(this.sign("POST", key, 60, { "content-type": "application/xml" }, { uploadId }), { method: "POST", headers: { "content-type": "application/xml" }, body });
    // S3 can answer 200 with an <Error> body when the failure happens after the response has started.
    const text = response.ok ? await response.text() : "";
    if (!response.ok || text.includes("<Error>")) throw new EngineError("validation_error", "The recording’s parts could not be joined. Record again, or upload the file instead.");
  }
  async abortMultipart(key: string, uploadId: string) {
    const response = await this.fetcher(this.sign("DELETE", key, 60, {}, { uploadId }), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new EngineError("provider_unavailable", "File storage could not cancel the upload. Try again.");
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
  async createMultipart(): Promise<never> { return this.fail(); }
  async partUrl(): Promise<never> { return this.fail(); }
  async completeMultipart(): Promise<never> { return this.fail(); }
  async abortMultipart(): Promise<never> { return this.fail(); }
}

/** Test store: objects in memory, URLs that name the object and the declared checksum. */
export class MemoryFileStore implements FileStore {
  readonly configured = true;
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async uploadUrl(key: string, options: { sha256Hex: string; contentType: string; bytes: number }) {
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
  /** Open multipart uploads: parts arrive through `putPart`, as a browser's PUTs would. */
  readonly uploads = new Map<string, { key: string; contentType: string; parts: Map<number, Uint8Array> }>();
  async createMultipart(key: string, contentType: string) {
    assertKey(key);
    const uploadId = `upload-${this.uploads.size + 1}-${crypto.randomUUID()}`;
    this.uploads.set(uploadId, { key, contentType, parts: new Map() });
    return uploadId;
  }
  async partUrl(key: string, uploadId: string, options: { partNumber: number; bytes: number }) {
    assertKey(key);
    return { url: `https://files.test/part/${key}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${options.partNumber}&bytes=${options.bytes}`, headers: {} };
  }
  /** Test hook: stores one part and returns its ETag. */
  putPart(uploadId: string, partNumber: number, bytes: Uint8Array) {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error("No such upload");
    upload.parts.set(partNumber, bytes);
    return `"etag-${partNumber}"`;
  }
  async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key || parts.some((part) => !upload.parts.has(part.partNumber) || part.etag !== `"etag-${part.partNumber}"`))
      throw new EngineError("validation_error", "The recording’s parts could not be joined. Record again, or upload the file instead.");
    const chunks = [...parts].sort((a, b) => a.partNumber - b.partNumber).map((part) => upload.parts.get(part.partNumber)!);
    const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.objects.set(key, { bytes: joined, contentType: upload.contentType });
    this.uploads.delete(uploadId);
  }
  async abortMultipart(_key: string, uploadId: string) {
    this.uploads.delete(uploadId);
  }
}
