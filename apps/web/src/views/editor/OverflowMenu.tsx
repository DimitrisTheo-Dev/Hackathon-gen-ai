import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";

export type OverflowItem = { id: string; label: string; icon: ReactNode; onSelect: () => void };

/**
 * Secondary actions for the Details footer. A plain menu button: arrow keys move, Escape closes
 * and returns focus, a press outside dismisses. It grows from its trigger; from the keyboard it
 * opens without animation.
 */
export function OverflowMenu({ label, items }: { label: string; items: OverflowItem[] }) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const options = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = options.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      // The editor is a dialog on phones: Escape closes this menu, not the whole editor.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      options[(at + step + options.length) % options.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      options.at(event.key === "Home" ? 0 : -1)?.focus();
    } else if (event.key === "Tab") setOpen(false);
  }

  return (
    <div className="editor-more" ref={root} onKeyDown={open ? keys : undefined}>
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={(event) => {
          setInstant(event.detail === 0);
          setOpen((value) => !value);
        }}
      >
        <Ellipsis size={17} aria-hidden="true" />
      </button>
      {open && (
        <div className="editor-menu" role="menu" aria-label={label} data-instant={instant || undefined}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                // Focus returns to the trigger first; an action that opens something may then move it.
                close();
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
