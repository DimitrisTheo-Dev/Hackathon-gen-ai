import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search, Folder, FileVideo, Plus, Plug, CalendarDays } from "lucide-react";
import type { Campaign } from "@castroom/contracts";
import { Modal } from "./ui";

export function CommandPalette({ campaigns, onClose, onCampaign, onItem, onCreate, onConnect, onReview }: {
  campaigns: Campaign[];
  onClose: () => void;
  onCampaign: (id: string) => void;
  onItem: (campaignId: string, itemId: string) => void;
  onCreate: () => void;
  onConnect: () => void;
  onReview?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => { input.current?.focus(); }, []);
  const entries = useMemo(() => [
    ...campaigns.map(c => ({ id: c.id, group: "Projects", title: c.title, detail: `${c.items.length} content items`, Icon: Folder, run: () => onCampaign(c.id) })),
    ...campaigns.flatMap(c => c.items.map(i => ({ id: i.id, group: "Content", title: i.title, detail: `${c.title} · v${i.revision}`, Icon: FileVideo, run: () => onItem(c.id, i.id) }))),
    { id: "new", group: "Actions", title: "Create a campaign", detail: "Start with your company brief", Icon: Plus, run: onCreate },
    { id: "connect", group: "Actions", title: "Connect your agent", detail: "Codex or Claude Code setup", Icon: Plug, run: onConnect },
    ...(onReview ? [{ id: "review", group: "Actions", title: "Review schedule", detail: "Inspect the exact publishing manifest", Icon: CalendarDays, run: onReview }] : []),
  ].filter(e => `${e.title} ${e.detail}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [campaigns, query, onCampaign, onItem, onCreate, onConnect, onReview]);
  const chosen = Math.min(active, Math.max(0, entries.length - 1));
  function execute(index: number) { const entry = entries[index]; if (entry) { onClose(); entry.run(); } }
  return <Modal title="Find in your studio" onClose={onClose} animateEntry={false}>
    <div className="command-search"><Search size={18} /><input ref={input} aria-label="Search projects, content and actions" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={entries.length ? `${listId}-${chosen}` : undefined} value={query} placeholder="Search projects, content, actions…" onChange={e => { setQuery(e.target.value); setActive(0); }} onKeyDown={e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive(n => entries.length ? (n + (e.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length : 0); }
      if (e.key === "Enter") { e.preventDefault(); execute(chosen); }
    }} /></div>
    <div className="command-results" role="listbox" id={listId} aria-label="Studio results">
      {entries.map((entry, index) => <div key={entry.id}>
        {entry.group !== entries[index - 1]?.group && <div className="command-group" aria-hidden="true">{entry.group}</div>}
        <button type="button" role="option" aria-selected={index === chosen} id={`${listId}-${index}`} tabIndex={-1} onMouseMove={() => setActive(index)} onClick={() => execute(index)}><entry.Icon size={18} /><span><strong>{entry.title}</strong><small>{entry.detail}</small></span></button>
      </div>)}
      {!entries.length && <p className="command-empty">No matching projects or content. Try another phrase.</p>}
    </div>
    <p className="command-help">↑ ↓ to choose · Enter to open · Esc to close</p>
  </Modal>;
}
