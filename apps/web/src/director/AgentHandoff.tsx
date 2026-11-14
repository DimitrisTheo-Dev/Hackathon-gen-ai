import { useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { AgentIcon } from '../components/AgentIcon';
import { ViewLink } from './Sources';

/**
 * Shown under a request this deployment could not write (no model connected). It offers the honest
 * alternative: the person's own agent, on their own subscription, writing through Faceful's MCP tools.
 * Nothing here claims Faceful wrote anything.
 */
export function AgentHandoff({ prompt, connected, onAgents }: { prompt: string; connected: boolean; onAgents?: () => void }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const text = useRef<HTMLPreElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setState('copied');
    } catch {
      // Clipboard blocked: select the prompt so the person can copy it themselves.
      const node = text.current;
      if (node) { const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
      setState('manual');
    }
  }
  return (
    <div className="agent-handoff">
      <div className="agent-handoff-head">
        <AgentIcon host="claude" size={30} tile />
        <div>
          <strong>Your own Claude Code can write this</strong>
          <p>It runs on your Claude subscription and saves drafts here through Faceful’s tools.</p>
        </div>
      </div>
      <pre className="agent-handoff-prompt" ref={text} tabIndex={0} aria-label="Prompt for your agent">{prompt}</pre>
      <div className="agent-handoff-actions">
        <button type="button" className="agent-handoff-copy" data-state={state} onClick={() => void copy()}>
          <span className="agent-handoff-icon" aria-hidden="true"><Copy size={14} /><Check size={14} strokeWidth={2.5} /></span>
          <span>{state === 'copied' ? 'Copied' : state === 'manual' ? `Selected · press ${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘C' : 'Ctrl+C'}` : 'Copy prompt'}</span>
        </button>
        {connected ? (
          <span className="agent-handoff-live"><i aria-hidden="true" />Your agent is connected · drafts it creates appear here</span>
        ) : (
          <ViewLink view="connect" onOpen={onAgents} className="agent-handoff-link">Open Agents<ArrowUpRight size={13} aria-hidden="true" /></ViewLink>
        )}
      </div>
      <span className="sr-only" role="status">{state === 'copied' ? 'Prompt copied.' : ''}</span>
    </div>
  );
}
