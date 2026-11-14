import { useEffect, useRef, useState, type CSSProperties } from "react";

export type AgentHost = "claude" | "codex" | "cursor" | "gemini" | "vscode" | "windsurf" | "zed" | "mcp";

/**
 * Each client's own mark, served from /icons (sources and trademark notes: /icons/NOTICE.md).
 * `scale` is how much of the tile the mark fills, set by eye so the seven read as one family;
 * `invert` draws a single-colour mark in white on a dark or saturated tile.
 */
const marks: Record<Exclude<AgentHost, "mcp">, { src: string; scale: number; surface: string; dark?: boolean; invert?: boolean }> = {
  claude: { src: "/icons/claude.svg", scale: 0.66, surface: "#d97757", dark: true, invert: true },
  codex: { src: "/icons/codex.svg", scale: 0.74, surface: "#ffffff" },
  cursor: { src: "/icons/cursor.svg", scale: 0.6, surface: "#14120b", dark: true, invert: true },
  gemini: { src: "/icons/gemini.svg", scale: 0.68, surface: "#ffffff" },
  vscode: { src: "/icons/vscode.svg", scale: 0.6, surface: "#ffffff" },
  windsurf: { src: "/icons/windsurf.svg", scale: 0.7, surface: "#f9f3e9" },
  zed: { src: "/icons/zed.svg", scale: 0.58, surface: "#084ccf", dark: true, invert: true },
};

const NEUTRAL_SURFACE = "#f0efea";
/** Light and dark tiles carry the same depth: a hairline, a lit top edge and a short contact shadow. */
const LIGHT_DEPTH = "inset 0 0 0 1px rgba(42, 42, 39, .09), inset 0 1px 0 rgba(255, 255, 255, .8), 0 1px 1.5px rgba(42, 42, 39, .1), 0 3px 6px -2px rgba(42, 42, 39, .16)";
const DARK_DEPTH = "inset 0 0 0 1px rgba(255, 255, 255, .1), inset 0 1px 0 rgba(255, 255, 255, .16), 0 1px 1.5px rgba(42, 42, 39, .18), 0 3px 6px -2px rgba(42, 42, 39, .26)";
const LIGHT_SHEEN = "linear-gradient(180deg, rgba(255, 255, 255, 0), rgba(42, 42, 39, .055))";
const DARK_SHEEN = "linear-gradient(180deg, rgba(255, 255, 255, .18), rgba(255, 255, 255, 0) 58%)";

/** A neutral connector, for "any MCP client" and for any mark that fails to load. It is nobody's logo. */
function GenericGlyph({ size, className }: { size: number | string; className: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flexShrink: 0, verticalAlign: "middle" }}>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}

/**
 * A client's mark at `size` pixels, or with `tile` the same mark on a rounded app-icon tile.
 * A mark names a client; it is not an endorsement or a compatibility claim.
 * A parent may set `--agent-icon-size` (any CSS length) to size a tile fluidly instead of in pixels.
 */
export function AgentIcon({ host, size = 24, tile = false }: { host: AgentHost; size?: number; tile?: boolean }) {
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    // An image that failed before hydration never fires onError here, so check once on mount.
    const node = image.current;
    if (node && node.complete && node.naturalWidth === 0) setFailed(true);
  }, []);
  const mark = host === "mcp" || failed ? null : marks[host];

  if (!tile) {
    if (!mark) return <GenericGlyph size={size} className={`agent-brand-icon agent-brand-${host}`} />;
    return <img ref={image} className={`agent-brand-icon agent-brand-${host}`} src={mark.src} width={size} height={size} alt="" aria-hidden="true" decoding="async" draggable={false} onError={() => setFailed(true)} style={{ flexShrink: 0, objectFit: "contain", verticalAlign: "middle" }} />;
  }

  const side = `var(--agent-icon-size, ${size}px)`;
  const dark = mark?.dark ?? false;
  const frame: CSSProperties = {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    inlineSize: side,
    blockSize: side,
    borderRadius: "24%",
    verticalAlign: "middle",
    color: "#2a2a27",
    background: `${dark ? DARK_SHEEN : LIGHT_SHEEN}, ${mark?.surface ?? NEUTRAL_SURFACE}`,
    boxShadow: dark ? DARK_DEPTH : LIGHT_DEPTH,
  };
  return (
    <span className={`agent-icon-tile agent-icon-${host}`} aria-hidden="true" style={frame}>
      {mark ? (
        <img ref={image} className={`agent-brand-icon agent-brand-${host}`} src={mark.src} width={size} height={size} alt="" decoding="async" draggable={false} onError={() => setFailed(true)} style={{ inlineSize: `${mark.scale * 100}%`, blockSize: `${mark.scale * 100}%`, objectFit: "contain", filter: mark.invert ? "brightness(0) invert(1)" : undefined }} />
      ) : (
        <GenericGlyph size="56%" className={`agent-brand-icon agent-brand-${host}`} />
      )}
    </span>
  );
}
