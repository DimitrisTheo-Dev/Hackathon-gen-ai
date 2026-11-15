import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { handle, type Env, type StoreBucket, type StoredBody, type StoredObject } from "../../apps/workspace-store/src/index";

/** R2-shaped bucket kept in memory, for tests. */
export function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; uploaded: Date; contentType?: string; customMetadata?: Record<string, string> }>();
  const describe = (key: string): StoredObject | null => {
    const found = objects.get(key);
    return found ? { key, size: found.bytes.length, uploaded: found.uploaded, httpEtag: `"${found.bytes.length}"`, customMetadata: found.customMetadata } : null;
  };
  const bucket: StoreBucket = {
    async get(key) {
      const found = objects.get(key);
      if (!found) return null;
      return { ...describe(key)!, body: new Response(found.bytes).body!, httpMetadata: { contentType: found.contentType } } as StoredBody;
    },
    async head(key) { return describe(key); },
    async put(key, value, options) {
      const bytes = value === null ? new Uint8Array() : new Uint8Array(value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer());
      objects.set(key, { bytes, uploaded: new Date(), contentType: options?.httpMetadata?.contentType, customMetadata: options?.customMetadata });
      return describe(key);
    },
    async delete(key) { objects.delete(key); },
    async list({ prefix, cursor, limit = 1000 }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = Number(cursor ?? 0) || 0;
      const truncated = start + limit < keys.length;
      return { objects: keys.slice(start, start + limit).map((key) => describe(key)!), truncated, cursor: truncated ? String(start + limit) : undefined };
    },
  };
  return { bucket, objects };
}

/** Serves the real Worker handler over HTTP on a random local port. */
export async function serveStore(env: Env): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
    const response = await handle(new Request(`http://store${req.url}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }), env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
