import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import type { Campaign } from '@castroom/contracts';

type Source = Campaign['sources'][number];

/** The site a source came from, without "www.", or "" for pasted text. */
export function sourceHost(url: string | null): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function SourceTile({ source }: { source: Source }) {
  const letter = (sourceHost(source.url) || source.title).trim().charAt(0).toUpperCase() || '·';
  return <span className="source-tile" aria-hidden="true">{letter}</span>;
}

/** A link that stays a real link (new tab, copy address) but lets the studio switch views in place when it can. */
export function ViewLink({ view, onOpen, className, children }: { view: 'connect' | 'brand'; onOpen?: () => void; className?: string; children: ReactNode }) {
  const href = `${typeof location === 'undefined' ? '/studio/' : location.pathname}?view=${view}`;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onOpen || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onOpen();
  };
  return <a className={className} href={href} onClick={open}>{children}</a>;
}

/**
 * The project's sources as cards to tap on or off. Each card is a toggle button (aria-pressed); its
 * name is the title and its description the site and excerpt, so a screen reader hears it once.
 */
export function SourceTray({ id, sources, selected, onToggle, onClose, onSources, instant = false }: {
  id: string; sources: Source[]; selected: string[]; onToggle: (id: string) => void; onClose: () => void; onSources?: () => void;
  /** Opened from the keyboard: appear at once, no entrance. */ instant?: boolean;
}) {
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    // Escape closes the tray, not the editor sheet around it.
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <div className="source-tray" id={id} role="group" aria-label="Project sources" data-instant={instant || undefined} onKeyDown={keys}>
      {sources.length > 0 ? (
        <div className="source-cards">
          {sources.map((source) => {
            const on = selected.includes(source.id);
            const host = sourceHost(source.url);
            return (
              <button type="button" className="source-card" key={source.id} aria-pressed={on} aria-labelledby={`${id}-${source.id}-name`} aria-describedby={`${id}-${source.id}-meta`} onClick={() => onToggle(source.id)}>
                <SourceTile source={source} />
                <span className="source-card-text">
                  <strong id={`${id}-${source.id}-name`}>{source.title}</strong>
                  <span id={`${id}-${source.id}-meta`}>
                    <small>{host || 'Supplied text'}</small>
                    {source.excerpt && <span className="source-card-excerpt">{source.excerpt}</span>}
                  </span>
                </span>
                <span className="source-card-check" aria-hidden="true"><Check size={12} strokeWidth={2.75} /></span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="source-empty">This project has no sources yet.</p>
      )}
      <p className="source-note">
        Uploads aren’t available yet. <ViewLink view="brand" onOpen={onSources}>Add sources in the Brand kit</ViewLink>
      </p>
    </div>
  );
}

/** Attached sources, shown inside the composer like attached files. */
export function AttachmentPills({ sources, selected, onRemove }: { sources: Source[]; selected: string[]; onRemove: (id: string) => void }) {
  const picked = selected.map((id) => sources.find((source) => source.id === id)).filter((source): source is Source => Boolean(source));
  if (!picked.length) return null;
  return (
    <ul className="attachment-pills" aria-label="Attached sources">
      {picked.map((source) => (
        <li className="attachment-pill" key={source.id}>
          <SourceTile source={source} />
          <span>{source.title}</span>
          <button type="button" aria-label={`Remove ${source.title}`} title="Remove" onClick={() => onRemove(source.id)}><X size={12} strokeWidth={2.25} aria-hidden="true" /></button>
        </li>
      ))}
    </ul>
  );
}
