/**
 * Local domain API for development: the same engine handlers the Vercel Functions export,
 * against the Supabase project in `.env.local`. Vite proxies /v1, /mcp and the OAuth
 * protected-resource metadata here (see apps/web/vite.config.ts).
 *
 *   corepack pnpm dev:api      # then, in another terminal: corepack pnpm dev
 */
import { createServer } from "node:http";
import { handleEngineRequest } from "../packages/engine/src/http";
import { getRuntime } from "../packages/engine/src/runtime";

const port = Number(process.env.API_PORT ?? 8787);
const deps = getRuntime();
const mcp = await import("../packages/engine/src/mcp").catch(() => null);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    // The raw bytes are forwarded untouched so webhook signatures verify exactly as in production.
    const request = new Request(url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
    const response = (await handleEngineRequest(deps, request, url.pathname)) ?? (mcp ? await mcp.handleMcpRequest(deps, request, url.pathname) : null) ?? new Response("Not found", { status: 404 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Local API error");
  }
}).listen(port, "127.0.0.1", () => console.log(`Faceful local API: http://127.0.0.1:${port}  (director: ${deps.config.llm ? "ai" : "basic"}, rendering: ${deps.config.renderWorkerToken ? "worker attached" : "not connected"}, billing: ${deps.config.stripe ? "sandbox" : "not configured"})`));
