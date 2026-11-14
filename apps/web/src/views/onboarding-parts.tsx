import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

/** Copy with visible and announced feedback. It settles back so a second copy is confirmed again. */
export function CopyAction({
  value,
  label,
  copiedLabel = "Copied",
  className = "",
  iconOnly = false,
  disabled = false,
  onCopied,
}: {
  value: string;
  label: string;
  copiedLabel?: string;
  className?: string;
  iconOnly?: boolean;
  disabled?: boolean;
  onCopied?: () => void;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      onCopied?.();
    } catch {
      setState("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2400);
  }
  const text = state === "copied" ? copiedLabel : state === "failed" ? "Select and copy manually" : label;
  return (
    <>
      <button type="button" className={`ob-copy ${className}`} data-state={state} disabled={disabled} aria-label={iconOnly ? label : undefined} onClick={() => void copy()}>
        <span className="ob-copy-icon" aria-hidden="true">{state === "copied" ? <Check size={15} /> : <Copy size={15} />}</span>
        {!iconOnly && <span>{text}</span>}
      </button>
      {/* Rendered empty first so the confirmation is announced when it changes. */}
      <span className="sr-only" role="status">{state === "copied" ? copiedLabel : state === "failed" ? "Copy failed. Select the text and copy it manually." : ""}</span>
    </>
  );
}

/** Two-to-four mutually exclusive choices. Native radios give arrow-key behaviour and a real group name. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  return (
    <fieldset className="ob-segmented" style={{ "--ob-count": options.length, "--ob-index": index } as React.CSSProperties} disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label key={option.value} data-checked={option.value === value || undefined}>
          <input type="radio" name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** "just now", "2 minutes ago", "in 29 days". */
export function relativeTime(iso: string, now: number): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const distance = Math.abs(seconds);
  if (!Number.isFinite(seconds)) return "";
  if (distance < 45) return "just now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (distance < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (distance < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

/** A numbered step whose badge turns into a tick once the step is done. */
export function Step({ number, title, state, children }: { number: number; title: ReactNode; state: "todo" | "current" | "done"; children?: ReactNode }) {
  return (
    <li className="ob-step-item" data-state={state}>
      <span className="ob-step-badge" aria-hidden="true">{state === "done" ? <Check size={15} strokeWidth={2.25} /> : number}</span>
      <div className="ob-step-body">
        <h3>
          <span className="sr-only">Step {number}{state === "done" ? ", done" : ""}: </span>
          {title}
        </h3>
        {children}
      </div>
    </li>
  );
}
