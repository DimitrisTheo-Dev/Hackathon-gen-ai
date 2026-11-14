const marks = {
  claude: '/icons/claude.svg',
  codex: '/icons/codex.svg',
  cursor: '/icons/cursor.svg',
  gemini: '/icons/gemini.svg',
  vscode: '/icons/vscode.svg',
  windsurf: '/icons/windsurf.svg',
  zed: '/icons/zed.svg',
} as const;
export type AgentHost = keyof typeof marks;
/**
 * Claude and Codex use their official product marks; the others are original Faceful glyphs
 * (see /icons/NOTICE.md). A mark names a client. It is not an endorsement or a compatibility claim.
 */
export function AgentIcon({ host, size = 24 }: { host: AgentHost; size?: number }) {
  return <img className={`agent-brand-icon agent-brand-${host}`} src={marks[host]} width={size} height={size} alt="" aria-hidden="true" decoding="async" style={{ flexShrink: 0, objectFit: 'contain', verticalAlign: 'middle' }} />;
}
