import { next } from "@vercel/functions";
import { handlePublicRequest, publicDocuments, publicPages, publicProblem, publicDiscoveryLinkHeader } from "./packages/public-api/src/index.js";

// Public presentation/discovery only. Private studio and domain routes pass through.
const pages = new Set(["/", "/index.html", ...publicPages.map(path => path.replace(/\/$/, "")), "/about", "/contact", "/privacy"]);
// The /logos design review page's fog texture, music beds (from scripts/logo-music.py) and recorded voice takes.
const logoReviewFiles = ["/art/fog.webp", ...["glow", "haze", "kalimba", "rise"].flatMap(bed => [`/audio/logo-music/${bed}-a.mp3`, `/audio/logo-music/${bed}-b.mp3`]), ...["connie", "holly", "jillian", "kelsey", "lori", "madison", "melina", "pippa"].map(voice => `/audio/logo-voice/ca-${voice}.mp3`)];
const files = new Set(["/favicon.svg", "/design.css", "/docs/docs.css", "/docs/docs.js", "/fonts/InterVariable.woff2", "/fonts/LICENSE.txt", "/art/grainient-sunlit.webp", "/icons/claude.svg", "/icons/codex.svg", "/icons/cursor.svg", "/icons/gemini.svg", "/icons/vscode.svg", "/icons/windsurf.svg", "/icons/zed.svg", "/icons/NOTICE.md", "/art/ATTRIBUTION.txt", "/og.png", "/llms.txt", "/robots.txt", "/sitemap.xml", "/manifest.webmanifest", "/sw.js", "/offline.html", "/tools/faceful-reel.mjs", "/icons/app-192.png", "/icons/app-512.png", "/icons/app-maskable-512.png", "/icons/apple-touch-icon.png", ...logoReviewFiles]);
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
  if (/^\/(?:assets|studio|dev|oauth|v1|api\/v1|api\/engine|api\/mcp|mcp|\.well-known\/oauth-protected-resource|claude-login-test|pitch|face-scan|logos)(?:\/|$)/.test(path)) return next();
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
  const suggestion = closestPage(normalized);
  if (wantsMd) return markdownResponse(request, notFoundMarkdown(path, suggestion), 404);
  return new Response(request.method === "HEAD" ? null : notFoundHtml(path, suggestion), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", Vary: "Accept", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", Link: publicDiscoveryLinkHeader } });
}

/* ── 404 ──────────────────────────────────────────────────────────────────────────────────────── */

/** Where a lost person or agent can go next. Every entry is a real, public route on this origin. */
const agentRoutes: Array<[path: string, what: string]> = [
  ["/llms.txt", "Agent instructions"],
  ["/api/public/status", "What this deployment has configured"],
  ["/openapi.json", "Public API, OpenAPI 3.1"],
  ["/docs/mcp/", "Connect over MCP"],
  ["/.well-known/mcp/server-card.json", "MCP server card"],
];
const suggestable = [...new Set([...publicPages, "/about/", "/contact/", "/privacy/", "/studio/", "/pitch/"])];

function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}
/** The public page a mistyped address most likely meant, or null when nothing is close. */
export function closestPage(path: string): string | null {
  const wanted = path.toLowerCase().replace(/\/+$/, "");
  if (!wanted || wanted.length > 80) return null;
  let best: { page: string; score: number } | null = null;
  for (const page of suggestable) {
    const candidate = page.replace(/\/+$/, "");
    const score = distance(wanted, candidate);
    if (score <= Math.max(2, Math.floor(candidate.length / 4)) && (!best || score < best.score)) best = { page, score };
  }
  return best?.page ?? null;
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const shown = (path: string) => (path.length > 64 ? `${path.slice(0, 61)}…` : path);

function notFoundMarkdown(path: string, suggestion: string | null) {
  return [
    "# Page not found",
    "",
    `Nothing is published at \`${shown(path).replace(/`/g, "")}\` on this origin.${suggestion ? ` Did you mean [${suggestion}](${suggestion})?` : ""}`,
    "",
    "## For agents",
    ...agentRoutes.map(([route, what]) => `- [${what}](${route})`),
    "",
    "Private studio routes (`/studio/`) require a signed-in person. The domain API is under `/v1`, the MCP endpoint is `/mcp`.",
    "",
  ].join("\n");
}

function notFoundHtml(path: string, suggestion: string | null) {
  const routes = agentRoutes.map(([route, what]) => `<li><a href="${route}"><code>${route}</code><span>${what}</span></a></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><meta name="theme-color" content="#FAFAF7"><title>Page not found · Faceful</title><link rel="icon" href="/favicon.svg"><link rel="alternate" type="text/markdown" href="/llms.txt" title="Agent instructions">
<style>
@font-face{font-family:InterVariable;src:url(/fonts/InterVariable.woff2) format("woff2");font-weight:100 900;font-display:swap}
:root{color-scheme:light;--ink:#2A2A27;--muted:#6E6C66;--faint:#75736C;--bg:#FAFAF7;--surface:#FFFFFF;--line:#E4E2DA;--subtle:#F1F0EB;--gold:#FFB000;--gold-edge:#B47A00;--ease:cubic-bezier(.23,1,.32,1)}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{min-height:100dvh;display:grid;place-items:center;padding:max(40px,env(safe-area-inset-top)) 16px max(40px,env(safe-area-inset-bottom));background:var(--bg);color:var(--ink);font:16px/1.55 InterVariable,Inter,system-ui,-apple-system,"Segoe UI",sans-serif;font-feature-settings:"cv11","ss01";-webkit-font-smoothing:antialiased;overflow-x:hidden}
body::before{content:"";position:fixed;inset:-20vh -10vw auto;height:70vh;background:url(/art/grainient-sunlit.webp) center/cover;opacity:.55;filter:saturate(1.05);-webkit-mask-image:radial-gradient(ellipse 60% 60% at 50% 0%,#000 0%,transparent 72%);mask-image:radial-gradient(ellipse 60% 60% at 50% 0%,#000 0%,transparent 72%);pointer-events:none;z-index:-1}
main{width:100%;max-width:34rem;animation:rise .6s var(--ease) both}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
@media (prefers-reduced-motion:reduce){main{animation:none}}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font-weight:600;letter-spacing:-.01em}
.brand svg{width:32px;height:32px;border-radius:9px}
.code{margin:48px 0 0;color:var(--ink);font-size:clamp(4.5rem,18vw,7.5rem);line-height:.9;font-weight:650;letter-spacing:-.06em;font-variant-numeric:tabular-nums}
.code span{background:linear-gradient(transparent 62%,rgba(255,176,0,.38) 62% 90%,transparent 90%)}
h1{margin:20px 0 8px;font-size:1.625rem;line-height:1.15;font-weight:600;letter-spacing:-.025em;text-wrap:balance}
p{margin:0;color:var(--muted);text-wrap:pretty}
.path{display:inline-block;max-width:100%;margin-top:14px;padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);overflow-wrap:anywhere}
.suggest{margin-top:18px;color:var(--ink)}
.suggest a{color:var(--ink);font-weight:600;text-decoration-color:var(--gold-edge);text-underline-offset:3px;text-decoration-thickness:2px}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 20px;border-radius:999px;font-weight:550;text-decoration:none;touch-action:manipulation;transition:transform .12s var(--ease),background-color .16s var(--ease)}
.button:active{transform:scale(.97)}
.primary{background:var(--ink);color:var(--bg)}
.primary:hover{background:#141413}
.secondary{background:var(--surface);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}
.secondary:hover{background:var(--subtle)}
section{margin-top:44px;padding:20px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.72);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
h2{margin:0 0 4px;font-size:.8125rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
section>p{font-size:.9375rem}
ul{list-style:none;margin:14px 0 0;padding:0}
li+li{border-top:1px solid var(--line)}
li a{display:flex;align-items:baseline;justify-content:space-between;gap:16px;min-height:44px;padding:10px 2px;color:var(--ink);text-decoration:none}
li a:hover code{text-decoration:underline;text-decoration-color:var(--gold-edge);text-underline-offset:3px}
li code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
li span{flex:none;color:var(--muted);font-size:.875rem;text-align:right}
.hint{margin-top:14px;font-size:.8125rem;color:var(--faint)}
.hint code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
a:focus-visible{outline:2px solid var(--ink);outline-offset:3px;border-radius:8px}
.button:focus-visible{border-radius:999px}
@media (max-width:480px){li a{flex-direction:column;gap:2px}li span{text-align:left}}
</style></head><body><main>
<a class="brand" href="/"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#F1F0EB"/><g fill="#2A2A27" transform="rotate(-9 24 24)"><rect x="12" y="15" width="6" height="23" rx="3"/><rect x="22" y="8" width="6" height="31" rx="3"/><rect x="32" y="18" width="6" height="16" rx="3"/></g></svg>Faceful</a>
<p class="code" aria-hidden="true"><span>404</span></p>
<h1>This page isn’t here</h1>
<p>Nothing is published at this address. It may have moved, or the link was mistyped.</p>
<code class="path">${escapeHtml(shown(path))}</code>
${suggestion ? `<p class="suggest">Did you mean <a href="${suggestion}">${suggestion}</a>?</p>` : ""}
<div class="actions"><a class="button primary" href="/studio/">Open the studio</a><a class="button secondary" href="/docs/">Read the docs</a></div>
<section aria-labelledby="agents"><h2 id="agents">For agents</h2><p>Machine-readable entry points on this origin. None need credentials.</p><ul>${routes}</ul><p class="hint">Send <code>Accept: text/markdown</code> to get this page as Markdown. The domain API is under <code>/v1</code>, MCP at <code>/mcp</code>.</p></section>
</main></body></html>`;
}
