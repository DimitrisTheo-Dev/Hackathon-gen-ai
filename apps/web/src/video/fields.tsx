import { useEffect, useRef, useState } from "react";
import type { Transition } from "@castroom/contracts";
import { round } from "./model";

/** Seconds input that lets people type freely and only re-formats when they leave the field. */
export function TimeField({ label, value, max, min = 0, step = 0.1, disabled, onChange, onCommit }: { label: string; value: number; max: number; min?: number; step?: number; disabled: boolean; onChange: (seconds: number) => void; onCommit?: () => void }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  return (
    <label className="time-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        onFocus={() => (focused.current = true)}
        onChange={(event) => {
          setText(event.target.value);
          if (Number.isFinite(event.target.valueAsNumber)) onChange(round(event.target.valueAsNumber));
        }}
        onBlur={() => {
          focused.current = false;
          setText(String(value));
          onCommit?.();
        }}
      />
    </label>
  );
}

/** A value that applies only when the person leaves the field (the video length: shortening drops clips). */
export function CommitField({ label, value, min, max, step, disabled, onCommit }: { label: string; value: number; min: number; max: number; step: number; disabled: boolean; onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max && parsed !== value) onCommit(parsed);
    else setText(String(value));
  };
  return (
    <label className="time-field">
      <span>{label}</span>
      <input type="number" inputMode="decimal" step={step} min={min} max={max} value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => event.key === "Enter" && commit()} />
    </label>
  );
}

export function RangeField({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (value: number) => void }) {
  return (
    <label className="range-field">
      <span>{label} {Math.round(value * 100)}%</span>
      <input type="range" min={0} max={1} step={0.05} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

const TRANSITIONS: Array<{ kind: Transition["kind"]; label: string }> = [
  { kind: "cut", label: "Cut" },
  { kind: "fade", label: "Fade" },
  { kind: "slide_up", label: "Slide up" },
  { kind: "zoom", label: "Zoom" },
];
export function TransitionField({ label, value, disabled, onChange }: { label: string; value: Transition; disabled: boolean; onChange: (value: Transition) => void }) {
  return (
    <div className="transition-field">
      <span>{label}</span>
      <div>
        <select aria-label={`${label} type`} value={value.kind} disabled={disabled} onChange={(event) => onChange({ kind: event.target.value as Transition["kind"], duration: event.target.value === "cut" ? 0 : value.duration || 0.3 })}>
          {TRANSITIONS.map((entry) => <option key={entry.kind} value={entry.kind}>{entry.label}</option>)}
        </select>
        {value.kind !== "cut" && (
          <input aria-label={`${label} length in seconds`} type="number" min={0.05} max={2} step={0.05} value={value.duration} disabled={disabled} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && onChange({ ...value, duration: Math.min(2, Math.max(0, round(event.target.valueAsNumber))) })} />
        )}
      </div>
    </div>
  );
}
