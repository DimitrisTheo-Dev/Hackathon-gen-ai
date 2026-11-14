import { handleEngineRequest } from "../packages/engine/src/http.js";
import { getRuntime } from "../packages/engine/src/runtime.js";

/**
 * Vercel Function for the shared domain API (`/v1/*`). vercel.json rewrites `/v1/:path*` here and
 * passes the original path as `__path`, so routing never depends on how the platform reports URLs.
 */
export const config = { maxDuration: 120 };

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const forwarded = url.searchParams.get("__path");
  const pathname = forwarded !== null ? `/v1/${forwarded.replace(/^\/+/, "")}` : url.pathname;
  let deps;
  try {
    deps = getRuntime();
  } catch {
    return Response.json(
      { error: { code: "provider_unavailable", message: "The studio engine is not configured on this deployment yet.", retryAfterSeconds: null, reviewUrl: null } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return (await handleEngineRequest(deps, request, pathname)) ?? new Response("Not found", { status: 404 });
}

export default { fetch: handle };
