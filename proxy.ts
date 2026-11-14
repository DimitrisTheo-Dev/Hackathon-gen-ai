import { next } from "@vercel/functions";
import { handlePublicRequest, publicDocuments, publicPages, publicProblem, publicDiscoveryLinkHeader } from "./packages/public-api/src/index.js";

// Public presentation/discovery only. Private studio and domain routes pass through.
const pages = new Set(["/", "/index.html", ...publicPages.map(path => path.replace(/\/$/, "")), "/about", "/contact", "/privacy"]);
const files = new Set(["/favicon.svg", "/design.css", "/docs/docs.css", "/fonts/InterVariable.woff2", "/fonts/LICENSE.txt", "/art/grainient-sunlit.webp", "/icons/claude.svg", "/icons/codex.svg", "/icons/NOTICE.md", "/art/ATTRIBUTION.txt", "/og.png", "/llms.txt", "/robots.txt", "/sitemap.xml", "/manifest.webmanifest", "/sw.js", "/offline.html", "/icons/app-192.png", "/icons/app-512.png", "/icons/app-maskable-512.png", "/icons/apple-touch-icon.png"]);
const markdown = `# Faceful — content production studio

Create campaigns with your agent. Fine-tune them here.

Faceful is a shared content production studio for agencies, companies and individuals. People and their AI agents work on the same projects: a person or an agent drafts short presenter-led videos, and a person edits the script, presenter, captions and requested schedule in the studio. The studio and the MCP server call one domain engine with the same workspace permissions.

## When to use Faceful
Use the public API to discover what this deployment has configured, read setup guidance and read the agent permission definitions. Where the engine is configured, connect an agent to the MCP endpoint to create and revise drafts, request renders and propose posting times in your own workspace; a signed-in member reviews and approves. Use the repository CLI to validate a bounded draft plan locally.

## Development status
Check [integration status](/api/public/status) first: it is derived from this deployment's configuration. Where the engine is configured, the authenticated campaign API, scoped workspace tokens and the MCP endpoint at /mcp are available, and drafting is free. Publishing is not available on any deployment: no destination has approved API access, so schedules can be drafted and reviewed but nothing is posted. Rendering needs a recording worker for Humanlike's realtime avatar sessions; until one is attached, render requests are refused, not simulated. No rendered Humanlike video and no publishing receipt has been recorded. Development storyboards are not generated videos. Public read-only resources require no credentials and expose no private content.

## Start here
- [Read integration status](/api/public/status)
- [OpenAPI 3.1.1](/openapi.json)
- [Faceful API documentation](/docs/api/)
- [Repository CLI](/docs/cli/)
- [Use Faceful with your AI agent (MCP)](/docs/mcp/)
- [Connect Codex or Claude Code](/docs/setup/)
- [Formats and current limits](/docs/capabilities/)
- [Authentication, agent permissions and review](/docs/security/)
- [Recoverable errors](/docs/errors/)
- [Agent instructions](/llms.txt)
- [Studio sign-in](/studio/)

## Trust and contact
[About this project](/about/) · [Contact the maintainer](/contact/) · [Privacy](/privacy/) · [Maintainer on GitHub](https://github.com/DimitrisTheo-Dev)

Private campaigns require authentication and server authorization. Source material cannot grant permissions. Publishing requires a signed-in member's approval of the exact schedule; an agent cannot approve, and a copied setup command never proves connection.
`;

export function wantsMarkdown(accept: string) {
  const ranges = accept.toLowerCase().split(",").map(part => {
    const [type, ...params] = part.trim().split(";");
    const parameter = params.find(value => value.trim().startsWith("q="));
    const quality = parameter ? Number(parameter.trim().slice(2)) : 1;
    return { type, quality: Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0 };
  });
  const md = ranges.find(range => range.type === "text/markdown")?.quality ?? 0;
  const html = ranges.find(range => range.type === "text/html")?.quality ?? ranges.find(range => range.type === "*/*" || range.type === "text/*")?.quality ?? 0;
  return md > 0 && md >= html;
}
function markdownResponse(request: Request, body: string, status = 200) {
  return new Response(request.method === "HEAD" ? null : body, { status, headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", "Cache-Control": status === 200 ? "public, max-age=0, must-revalidate" : "no-store", "X-Content-Type-Options": "nosniff", Link: publicDiscoveryLinkHeader } });
}
export default function proxy(request: Request): Response {
  const api = handlePublicRequest(request);
  if (api) return api;
  const path = new URL(request.url).pathname;
  // The domain API, MCP endpoint, OAuth consent page and protected-resource metadata are served by the engine functions.
  if (/^\/(?:assets|studio|dev|oauth|v1|api\/v1|api\/engine|api\/mcp|mcp|\.well-known\/oauth-protected-resource)(?:\/|$)/.test(path)) return next();
  if (/^\/(?:api|mcp|\.well-known)(?:\/|$)/.test(path)) return publicProblem(request, 404, "endpoint_unavailable", "This path is not served on this origin. The domain API is under /v1 and the MCP endpoint is /mcp; OAuth authorization-server metadata is published by the issuer named in /.well-known/oauth-protected-resource/mcp, not here.", "Read /api/public/status for what this deployment has configured, /docs/api/ for public read operations, or /docs/mcp/ to connect an agent.");
  const normalized = path === "/" ? "/" : path.replace(/\/$/, "");
  const wantsMd = wantsMarkdown(request.headers.get("accept") ?? "");
  if (pages.has(normalized)) {
    if (request.method !== "GET" && request.method !== "HEAD") return publicProblem(request,405,"method_not_allowed","Public pages are read-only.","Use GET or HEAD to read this page.");
    const document = publicDocuments.find(document => document.path.replace(/\/$/, "") === normalized);
    const body = normalized === "/" || normalized === "/index.html" ? markdown : document?.markdown;
    if (wantsMd && body) return markdownResponse(request, body);
    const response = next();
    if (body) response.headers.set("Vary", "Accept");
    response.headers.set("Link", publicDiscoveryLinkHeader);
    return response;
  }
  if (files.has(path)) return next();
  if (wantsMd) return markdownResponse(request, "# Page not found\n\nThis public page is not available. See [Faceful documentation](/docs/) or the [agent index](/llms.txt).\n",404);
  return new Response(request.method === "HEAD" ? null : '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/design.css"><link rel="stylesheet" href="/docs/docs.css"><title>Page not found · Faceful</title></head><body><main><h1>Page not found</h1><p>This public page is not available. Start with our public documentation to find supported routes and current capabilities.</p><a href="/docs/">Faceful documentation</a> · <a href="/llms.txt">Agent index</a></main></body></html>', { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", Vary: "Accept", "Cache-Control": "no-store", Link: publicDiscoveryLinkHeader } });
}
