const claude = '/icons/claude.svg';
const codex = '/icons/codex.svg';
/** Official product marks identify setup targets, not an endorsement. */
export function AgentIcon({ host, size = 24 }: { host: 'claude' | 'codex'; size?: number }) {
  return <img className={`agent-brand-icon agent-brand-${host}`} src={host === 'claude' ? claude : codex} width={size} height={size} alt="" aria-hidden="true" style={{ flexShrink: 0, objectFit: 'contain', verticalAlign: 'middle' }} />;
}
