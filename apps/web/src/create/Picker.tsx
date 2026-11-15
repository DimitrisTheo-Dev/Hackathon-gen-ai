import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { LANGUAGES, matchesLanguage } from "./languages";

/**
 * A small dropdown for the New project flow: a pill that names the setting and shows its value, and a menu of
 * options under it. Arrow keys move through the options, Escape closes it without closing the flow.
 * The menu is placed against the window, under the pill or above it when there is more room there, and kept on screen,
 * so a scrolling panel (the home composer's) never cuts it off and a pill near a phone's edge still opens fully.
 */
export function Menu({ label, value, align = "start", disabled = false, hint, children }: { label: string; value: ReactNode; align?: "start" | "end"; disabled?: boolean; hint?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      const element = menu.current;
      if (!box || !element || !wrap.current) return;
      const gutter = 12;
      const gap = 6;
      // A transformed ancestor moves "fixed" off the window's corner; a probe at (0, 0) says by how much.
      const probe = document.createElement("span");
      probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0";
      wrap.current.append(probe);
      const origin = probe.getBoundingClientRect();
      probe.remove();
      const width = Math.min(element.offsetWidth, innerWidth - gutter * 2);
      const left = Math.min(Math.max(gutter, align === "end" ? box.right - width : box.left), innerWidth - gutter - width);
      const below = innerHeight - box.bottom - gap - gutter;
      const above = box.top - gap - gutter;
      const up = element.scrollHeight > below && above > below;
      const room = Math.max(120, up ? above : below);
      const top = up ? box.top - gap - Math.min(element.scrollHeight, room) : box.bottom + gap;
      Object.assign(element.style, { position: "fixed", left: `${left - origin.left}px`, right: "auto", top: `${top - origin.top}px`, maxHeight: `${room}px`, transformOrigin: up ? "bottom left" : "" });
    };
    place();
    const moved = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) place();
    };
    addEventListener("resize", place);
    addEventListener("scroll", moved, true);
    return () => {
      removeEventListener("resize", place);
      removeEventListener("scroll", moved, true);
    };
  }, [open, align]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    // The search field, or else the chosen option, takes focus when the menu opens.
    requestAnimationFrame(() => (wrap.current?.querySelector<HTMLElement>(".np-menu input") ?? wrap.current?.querySelector<HTMLElement>('.np-menu [aria-selected="true"]') ?? wrap.current?.querySelector<HTMLElement>(".np-menu [role=option]"))?.focus());
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = [...(wrap.current?.querySelectorAll<HTMLElement>(".np-menu [role=option]:not(:disabled)") ?? [])];
    if (!options.length) return;
    event.preventDefault();
    const at = options.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1) : Math.min(options.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
    options[next].focus();
    options[next].scrollIntoView({ block: "nearest" });
  }
  return (
    <div className="np-menu-wrap" ref={wrap} onKeyDown={open ? keys : undefined}>
      <button ref={trigger} type="button" className={`np-select${open ? " is-open" : ""}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} title={hint} onClick={() => setOpen((current) => !current)}>
        <span className="np-select-label">{label}</span>
        <span className="np-select-value">{value}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div ref={menu} className={`np-menu np-menu-${align}`} id={id}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

export function Option({ selected, onSelect, disabled = false, children }: { selected: boolean; onSelect: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" role="option" aria-selected={selected} disabled={disabled} className="np-option" onClick={onSelect}>
      <span className="np-option-body">{children}</span>
      <Check size={14} aria-hidden="true" className="np-option-check" />
    </button>
  );
}

/** Every language, searchable by English name, native name or code, each with its flag. */
export function LanguageList({ label, selected, exclude = [], limit, onPick }: { label: string; selected: string[]; exclude?: string[]; limit?: number; onPick: (code: string) => void }) {
  const [query, setQuery] = useState("");
  const shown = LANGUAGES.filter((language) => !exclude.includes(language.code) && matchesLanguage(language, query));
  const full = limit !== undefined && selected.length >= limit;
  return (
    <>
      <label className="np-menu-search">
        <Search size={14} aria-hidden="true" />
        <span className="sr-only">Search languages</span>
        <input value={query} placeholder="Search languages" onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="np-menu-list" role="listbox" aria-label={label} aria-multiselectable={limit !== undefined || undefined}>
        {shown.map((language) => {
          const on = selected.includes(language.code);
          return (
            <Option key={language.code} selected={on} disabled={!on && full} onSelect={() => onPick(language.code)}>
              <span className="np-flag" aria-hidden="true">
                {language.flag}
              </span>
              <span lang={language.code}>{language.native}</span>
              {language.native !== language.name && <span className="np-option-sub">{language.name}</span>}
            </Option>
          );
        })}
        {!shown.length && <p className="np-menu-empty">No language matches “{query}”.</p>}
      </div>
    </>
  );
}
