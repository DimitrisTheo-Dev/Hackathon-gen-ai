/**
 * Where a reel's media may come from, and how the worker gets it.
 *
 * Only exact hosts: the engine's own Supabase project (SUPABASE_URL) and R2 account endpoint (FACEFUL_R2_ACCOUNT_ID),
 * plus MEDIA_HOST_ALLOWLIST. Never a wildcard (anyone can own a *.supabase.co project), never an address, https only.
 * The worker downloads every file itself, checking each redirect like the first request, and serves the copies to the
 * renderer from 127.0.0.1. Headless Chrome and Remotion's downloader follow redirects anywhere and can't be told not
 * to, so they never get a link that leaves this machine: a 302 to 169.254.169.254 or a private address goes nowhere.
 */
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export class MediaRefused extends Error {}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** The exact host names this worker fetches media from. */
export function mediaHosts(env: Record<string, string | undefined>): string[] {
  const hosts = new Set<string>();
  const add = (value: string | undefined) => {
    const host = value?.trim().toLowerCase().replace(/\.$/, "");
    if (host && HOSTNAME.test(host) && !/^[\d.]+$/.test(host)) hosts.add(host);
  };
  try {
    if (env.SUPABASE_URL) add(new URL(env.SUPABASE_URL).hostname);
  } catch {
    /* not a URL: left out, and media from it is refused */
  }
  const account = env.FACEFUL_R2_ACCOUNT_ID?.trim();
  if (account && /^[a-f0-9]{32}$/.test(account)) add(`${account}.r2.cloudflarestorage.com`);
  for (const host of (env.MEDIA_HOST_ALLOWLIST ?? "").split(",")) add(host);
  return [...hosts];
}

export function allowedMediaUrl(url: string, hosts: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.port === "" && hosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host || "an unknown host";
  } catch {
    return "an invalid address";
  }
};

/** Fetches one media file, following at most three redirects, each to an allowed host. */
export async function fetchMedia(url: string, hosts: readonly string[], fetcher: typeof fetch = fetch): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!allowedMediaUrl(current, hosts)) throw new MediaRefused(`Media from ${hostOf(current)} isn't allowed on this worker. Upload it as a draft file instead.`);
    const response = await fetcher(current, { redirect: "manual", signal: AbortSignal.timeout(300_000) });
    if (response.status < 300 || response.status > 399) {
      if (!response.ok || !response.body) throw new Error(`${hostOf(current)} answered ${response.status} for a media file.`);
      return response;
    }
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location || hop >= 3) throw new MediaRefused(`${hostOf(current)} redirected a media file ${location ? "too many times" : "without saying where"}.`);
    current = new URL(location, current).href;
  }
}

const EXTENSIONS: Record<string, string> = {
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg", "audio/webm": ".webm", "audio/flac": ".flac",
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
};
/** Remotion picks a decoder from the file name, so each copy keeps a fitting extension. */
function extensionFor(url: string, type: string): string {
  if (EXTENSIONS[type]) return EXTENSIONS[type];
  const extension = extname(new URL(url).pathname).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(extension) ? extension : ".bin";
}

export type StagedMedia = { url: (original: string) => string; close: () => Promise<void> };
/**
 * Downloads each URL once into `dir` and serves the copies on 127.0.0.1, under a random path, until `close`.
 * `made` are files this worker made itself (a voiceover), served the same way under their key.
 */
export async function stageMedia(
  urls: Iterable<string>,
  dir: string,
  hosts: readonly string[],
  options: { fetcher?: typeof fetch; maxBytes?: number; made?: Array<{ key: string; bytes: Uint8Array; type: string }> } = {},
): Promise<StagedMedia> {
  const maxBytes = options.maxBytes ?? 1024 ** 3;
  await mkdir(dir, { recursive: true });
  const names = new Map<string, string>();
  const files = new Map<string, { path: string; type: string; size: number }>();
  for (const made of options.made ?? []) {
    const name = `${files.size}${EXTENSIONS[made.type] ?? ".bin"}`;
    await writeFile(join(dir, name), made.bytes);
    files.set(name, { path: join(dir, name), type: made.type, size: made.bytes.byteLength });
    names.set(made.key, name);
  }
  for (const url of new Set(urls)) {
    const response = await fetchMedia(url, hosts, options.fetcher);
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || "application/octet-stream";
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new MediaRefused(`A media file from ${hostOf(url)} is larger than ${maxBytes} bytes.`);
    }
    const name = `${files.size}${extensionFor(url, type)}`;
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        done(size > maxBytes ? new MediaRefused(`A media file from ${hostOf(url)} is larger than ${maxBytes} bytes.`) : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), limit, createWriteStream(join(dir, name)));
    files.set(name, { path: join(dir, name), type, size });
    names.set(url, name);
  }
  const secret = randomBytes(16).toString("hex");
  const server = createServer((request, response) => {
    const [, prefix, name] = /^\/([0-9a-f]{32})\/([^/]+)$/.exec(request.url ?? "") ?? [];
    const file = prefix === secret ? files.get(name) : undefined;
    if (!file || (request.method !== "GET" && request.method !== "HEAD")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": file.type, "content-length": String(file.size), "access-control-allow-origin": "*", "cache-control": "no-store" });
    if (request.method === "HEAD") response.end();
    else createReadStream(file.path).pipe(response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${secret}`;
  return {
    url: (original) => {
      const name = names.get(original);
      if (!name) throw new Error("That media file was not staged.");
      return `${origin}/${name}`;
    },
    close: () => new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}
