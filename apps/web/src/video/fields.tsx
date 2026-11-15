import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Transition, VideoClip } from "@castroom/contracts";
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

/* ── Where a video clip sits in the frame: one visual choice for layer and layout ── */
type Placement = "main" | VideoClip["layout"];
/** Each placement's box as a share of the 1080 × 1920 frame, matching Reel.tsx (split: 860px tall; window: 90px in, 300px down, 900px tall). */
const BOXES: Record<Placement, CSSProperties> = {
  main: { inset: 0 },
  full: { inset: 0 },
  split: { left: 0, right: 0, top: 0, height: "44.79%" },
  window: { left: "8.33%", right: "8.33%", top: "15.63%", height: "46.88%" },
};
const PLACEMENTS: Array<{ id: Placement; label: string; hint: string }> = [
  { id: "main", label: "Main picture", hint: "Fills the frame, under everything" },
  { id: "full", label: "Full frame", hint: "Covers the whole frame" },
  { id: "split", label: "Split screen", hint: "Top half; the main picture moves below" },
  { id: "window", label: "Window", hint: "A framed box over the main picture" },
];
const placementOf = (clip: Pick<VideoClip, "layer" | "layout">): Placement => (clip.layer === 0 ? "main" : clip.layout);
/** Plain words for where a clip sits, e.g. "Overlay · Split screen". */
const placementLabel = (clip: Pick<VideoClip, "layer" | "layout">) => (clip.layer === 0 ? "Main picture" : `Overlay · ${PLACEMENTS.find((entry) => entry.id === clip.layout)!.label}`);

export function PlacementField({ name, clip, disabled, onChange }: { name: string; clip: Pick<VideoClip, "layer" | "layout">; disabled: boolean; onChange: (patch: Pick<VideoClip, "layer" | "layout">) => void }) {
  const current = placementOf(clip);
  return (
    <fieldset className="placement-field" disabled={disabled}>
      <legend>Where it sits</legend>
      <div className="placement-options">
        {PLACEMENTS.map((option) => (
          <label key={option.id} className="placement-option" title={option.hint}>
            <input type="radio" name={name} value={option.id} checked={current === option.id} onChange={() => onChange(option.id === "main" ? { layer: 0, layout: "full" } : { layer: 1, layout: option.id })} />
            <span className={`placement-thumb ${option.id}`} aria-hidden="true"><span style={BOXES[option.id]} /></span>
            <span className="placement-name">{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Outlines the selected clip's box on the preview and says what it is, so an overlay's place is visible at a glance. */
export function PlacementOutline({ clip, label }: { clip: Pick<VideoClip, "layer" | "layout">; label: string }) {
  const placement = placementOf(clip);
  return (
    <div className={`placement-outline ${placement}`} style={BOXES[placement]} aria-hidden="true">
      <span>{placementLabel(clip)}{label ? ` · ${label}` : ""}</span>
    </div>
  );
}
