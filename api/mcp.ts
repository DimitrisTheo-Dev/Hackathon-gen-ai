import { handleMcpRequest } from "../packages/engine/src/mcp.js";
import { getRuntime } from "../packages/engine/src/runtime.js";

/**
 * Vercel Function for the remote MCP server (`/mcp`) and its OAuth protected-resource metadata
 * (`/.well-known/oauth-protected-resource[/mcp]`). vercel.json rewrites those paths here and passes
 * the original path as `__path`, so routing never depends on how the platform reports URLs.
 * It shares one runtime — store, config, token verifier — with the `/v1` domain API.
 */
export const config = { maxDuration: 120 };

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const forwarded = url.searchParams.get("__path");
  const pathname = forwarded !== null ? `/${forwarded.replace(/^\/+/, "")}` : url.pathname;
  let deps;
  try {
    deps = getRuntime();
  } catch {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "The studio engine is not configured on this deployment yet." }, id: null },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return (await handleMcpRequest(deps, request, pathname)) ?? new Response("Not found", { status: 404 });
}

export default { fetch: handle };
