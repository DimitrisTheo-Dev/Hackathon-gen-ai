import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * One row of the Details list: a label, its current value, and the controls behind it.
 * The value sits beside the button (described by it, not part of its name), so the row reads
 * "Channels" to assistive technology and to tests, and "Channels — 3 channels" as a description.
 * A panel opened from the keyboard appears at once; a pointer gets a short fade.
 */
export function DetailSection({
  id,
  label,
  value,
  open,
  instant = false,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  value?: ReactNode;
  open: boolean;
  instant?: boolean;
  onToggle: (viaKeyboard: boolean) => void;
  children: ReactNode;
}) {
  return (
    <section className="detail-section" data-open={open} data-instant={instant || undefined}>
      <div className="detail-row">
        <h3>
          <button
            type="button"
            id={`${id}-trigger`}
            aria-expanded={open}
            aria-controls={open ? `${id}-panel` : undefined}
            aria-describedby={value ? `${id}-value` : undefined}
            // A click with no pointer detail came from Enter or Space.
            onClick={(event) => onToggle(event.detail === 0)}
          >
            {label}
          </button>
        </h3>
        {value && (
          <span className="detail-value" id={`${id}-value`}>
            {value}
          </span>
        )}
        <ChevronRight className="detail-chevron" size={15} aria-hidden="true" />
      </div>
      {open && (
        <div className="detail-panel" id={`${id}-panel`} role="group" aria-labelledby={`${id}-trigger`}>
          {children}
        </div>
      )}
    </section>
  );
}
