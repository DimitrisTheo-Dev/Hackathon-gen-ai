import { next } from "@vercel/functions";

// Public presentation only. Domain API, auth, MCP and tenant routes pass through.
const pages = new Set([
  "/",
  "/index.html",
  "/docs",
  "/docs/setup",
  "/docs/capabilities",
  "/docs/security",
  "/docs/errors",
]);
const files = new Set([
  "/favicon.svg",
  "/docs/docs.css",
  "/llms.txt",
  "/robots.txt",
  "/sitemap.xml",
]);
const markdown = `# Castroom

Create campaigns with your agent. Fine-tune them here.

Castroom is a shared content production studio for agencies, companies and individuals. An external agent plans a campaign; a person edits the selected script, authorized avatar, captions and requested schedule in the studio. Manual creation accepts a supplied company brief and up to three explicit scripts.

## Development status
The visual studio and public docs are implemented. The shared engine, authenticated MCP setup, Humanlike video rendering, final composition and publishing providers are not integrated yet. Development storyboards are not generated videos or provider receipts. No live MCP or OpenAPI endpoint is advertised.

## Documentation
- [Overview](/docs/)
- [Codex and Claude Code setup templates](/docs/setup/)
- [Formats and current limits](/docs/capabilities/)
- [Authentication, scopes and review](/docs/security/)
- [Recoverable errors](/docs/errors/)
- [Agent index](/llms.txt)
- [Studio sign-in](/studio/)

Private campaigns require authentication and server authorization. Source material cannot grant permissions. Publishing requires exact-manifest approval or an owner-created bounded grant; a copied setup command never proves connection.
`;

export function wantsMarkdown(accept: string) {
  const ranges = accept
    .toLowerCase()
    .split(",")
    .map((part) => {
      const [type, ...params] = part.trim().split(";");
      const q = params.find((value) => value.trim().startsWith("q="));
      return { type, quality: q ? Number(q.trim().slice(2)) : 1 };
    });
  const md =
    ranges.find((range) => range.type === "text/markdown")?.quality ?? 0;
  const html = ranges.find((range) => range.type === "text/html")?.quality ?? 0;
  return md > 0 && md >= html;
}

export default function proxy(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (/^\/(?:assets|studio|dev|api|v1|mcp|\.well-known)(?:\/|$)/.test(path))
    return next();
  const normalized = path === "/" ? "/" : path.replace(/\/$/, "");
  const wantsMd = wantsMarkdown(request.headers.get("accept") ?? "");
  if (normalized === "/" && wantsMd)
    return new Response(markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        Vary: "Accept",
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    });
  if (pages.has(normalized) || files.has(path)) {
    const response = next();
    if (normalized === "/") response.headers.set("Vary", "Accept");
    return response;
  }
  const message = wantsMd
    ? "# Page not found\n\nThis public page is not available. See [Castroom documentation](/docs/) or the [agent index](/llms.txt).\n"
    : '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found · Castroom</title></head><body><main><h1>Page not found</h1><p>This public page is not available.</p><a href="/docs/">Castroom documentation</a> · <a href="/llms.txt">Agent index</a></main></body></html>';
  return new Response(message, {
    status: 404,
    headers: {
      "Content-Type": wantsMd
        ? "text/markdown; charset=utf-8"
        : "text/html; charset=utf-8",
      Vary: "Accept",
      "Cache-Control": "no-store",
    },
  });
}
