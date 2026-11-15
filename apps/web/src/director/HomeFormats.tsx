import { createContext, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, LayoutTemplate, X } from "lucide-react";
import type { LibraryTemplate } from "@castroom/contracts";

/**
 * The template library for Create, provided by the studio (which loads it) and read by the Director panel, so the
 * editor between them does not have to pass it along. `null` while loading or where there is no library.
 */
export const FormatsContext = createContext<{ formats: LibraryTemplate[] | null; onAll?: () => void }>({ formats: null });

/** The formats offered first on Create: presenter formats, then two that need nobody on camera. */
const ORDER = ["talking-tip", "myth-react", "hosted-list", "faq-cards", "kinetic-type", "chat-qa"];

export function homeFormats(all: LibraryTemplate[]): LibraryTemplate[] {
  const ranked = [...all].sort((a, b) => rank(a.id) - rank(b.id));
  return ranked.slice(0, 6);
}
function rank(id: string) {
  const index = ORDER.indexOf(id);
  return index < 0 ? ORDER.length : index;
}

/** The brief a format starts: its own length and purpose, then the topic for the person to finish. */
export function formatBrief(format: LibraryTemplate): string {
  const [low, high] = format.durationRange;
  const purpose = format.useFor.replace(/\.$/, "");
  return `Make a ${format.name.toLowerCase()} (${low}–${high} s, vertical) for ${purpose.charAt(0).toLowerCase()}${purpose.slice(1)}. Topic: `;
}

/** If the person rewrote the brief, the chosen format still reaches the Director. */
export function withFormat(text: string, format: LibraryTemplate | null): string {
  if (!format || text.toLowerCase().includes(format.name.toLowerCase())) return text;
  const [low, high] = format.durationRange;
  return `${format.name} format (${low}–${high} s, vertical). ${text}`;
}

/** The chosen format, shown inside the composer like an attachment, so it is clear what the request starts from. */
export function FormatPill({ format, onRemove }: { format: LibraryTemplate; onRemove: () => void }) {
  return (
    <div className="format-pill-row">
      <span className="format-pill">
        <LayoutTemplate size={13} aria-hidden="true" />
        <span>Format · {format.name}</span>
        <button type="button" aria-label={`Remove the ${format.name} format`} onClick={onRemove}><X size={13} aria-hidden="true" /></button>
      </span>
    </div>
  );
}

/**
 * "Start from a format": the template library's own posters. Hovering or focusing one plays its rendered sample,
 * muted; choosing one starts the brief in the composer. Nothing is created until the person sends it.
 */
export function FormatStrip({ formats, selected, onPick, onAll, total }: { formats: LibraryTemplate[]; selected: string | null; onPick: (format: LibraryTemplate) => void; onAll?: () => void; total: number }) {
  return (
    <section className="home-formats" aria-labelledby="home-formats-title">
      <div className="home-formats-head">
        <h4 id="home-formats-title">Start from a format</h4>
        {onAll && <button type="button" className="text-button" onClick={onAll}>See all {total}<ArrowRight size={13} aria-hidden="true" /></button>}
      </div>
      <ul className="home-formats-row">
        {formats.map((format, index) => <li key={format.id} style={{ "--i": index } as CSSProperties}><FormatCard format={format} selected={selected === format.id} onPick={() => onPick(format)} /></li>)}
      </ul>
    </section>
  );
}

function FormatCard({ format, selected, onPick }: { format: LibraryTemplate; selected: boolean; onPick: () => void }) {
  const [playing, setPlaying] = useState(false);
  const reduced = useRef(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const start = () => { if (!reduced.current && format.videoUrl) setPlaying(true); };
  const stop = () => setPlaying(false);
  const [low, high] = format.durationRange;
  return (
    <button type="button" className="home-format" aria-pressed={selected} aria-label={`${format.name}, ${low} to ${high} seconds: ${format.useFor}`} onClick={onPick} onPointerEnter={start} onPointerLeave={stop} onFocus={start} onBlur={stop}>
      <span className="home-format-poster" data-playing={playing || undefined}>
        {format.posterUrl && <img src={format.posterUrl} alt="" loading="lazy" decoding="async" onLoad={(event) => { event.currentTarget.dataset.loaded = ""; }} />}
        {playing && format.videoUrl && <video src={format.videoUrl} muted loop playsInline autoPlay preload="auto" aria-hidden="true" onPlaying={(event) => { event.currentTarget.dataset.on = ""; }} />}
      </span>
      <span className="home-format-text"><strong>{format.name}</strong><small>{low}–{high} s</small></span>
    </button>
  );
}
