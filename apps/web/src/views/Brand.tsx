import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { ArrowUpRight, Check, ChevronDown, FileText, Link2, Lock, Palette, PenLine, Plus, X } from "lucide-react";
import {
  BRAND_LIMITS,
  SOURCE_LIMITS,
  type Brand as BrandKit,
  type Campaign,
  type Source,
  type StudioContext,
  type UpdateBrandInput,
} from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { Modal, Notice } from "../components/ui";
import "../brand.css";

/* ───────────── vocabulary ───────────── */

/** A small curated palette that sits well on the warm canvas. Any #RRGGBB can still be typed. */
const SWATCHES = [
  { name: "Sage", hex: "#5F6C66" },
  { name: "Charcoal", hex: "#2A2A27" },
  { name: "Mist", hex: "#4F7A94" },
  { name: "Teal", hex: "#2F6F73" },
  { name: "Olive", hex: "#6B7A3A" },
  { name: "Gold", hex: "#D9A21B" },
  { name: "Clay", hex: "#B4583A" },
  { name: "Sand", hex: "#CDBB94" },
];
/** The same presets as the New campaign flow, so the two places feel like one product. */
const TONES = ["Clear", "Warm", "Calm", "Playful", "Confident", "Expert", "Direct", "Inspiring"];
const AUDIENCES = ["New customers", "Existing customers", "Small businesses", "Professionals", "Parents", "Students"];

type Field = "name" | "description" | "tone" | "audience" | "color" | "rules";
type Patch = Partial<Pick<BrandKit, Field>>;

const tokens = (text: string) => text.split(/[,;\n]+/).map((part) => part.trim()).filter(Boolean);
const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
const capital = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);
/** Adds or removes one entry in a comma-separated field, leaving anything the person typed untouched. */
function toggleToken(text: string, token: string): string {
  const list = tokens(text);
  return (list.some((part) => same(part, token)) ? list.filter((part) => !same(part, token)) : [...list, token]).join(", ");
}
const plural = new Intl.PluralRules("en");
const drafts = (n: number) => `${n} ${plural.select(n) === "one" ? "draft" : "drafts"}`;
const assets = (n: number) => `${n} permitted media ${plural.select(n) === "one" ? "asset" : "assets"}`;
function messageOf(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Couldn’t save. Check your connection and try again.";
}
function firstLetter(text: string, fallback: string) {
  return (Array.from(text.trim())[0] ?? fallback).toLocaleUpperCase();
}
/** White or charcoal, whichever reads better on the brand colour (WCAG relative luminance). */
function inkOn(hex: string) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return "#FFFFFF";
  const channel = (offset: number) => {
    const value = parseInt(match[1].slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  const charcoal = 0.0232; // relative luminance of #2A2A27
  return (1.05 / (luminance + 0.05)) >= (luminance + 0.05) / (charcoal + 0.05) ? "#FFFFFF" : "#2A2A27";
}
function hostOf(url: string | null) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
/** The server's rule, applied early: a web link without embedded credentials. A bare domain gets https://. */
function normalizeLink(value: string): { url: string | null; ok: boolean } {
  const trimmed = value.trim();
  if (!trimmed) return { url: null, ok: true };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return { url: url.href, ok: ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.hostname.includes(".") };
  } catch {
    return { url: withScheme, ok: false };
  }
}

/**
 * Grows a one-row textarea with its text. A single line keeps the browser's own height (one row, exactly the
 * height of the text it replaces); only wrapped text sets a height, border included, so nothing shifts.
 */
function useGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxPx: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "";
    if (el.scrollHeight > el.clientHeight + 1) el.style.height = `${Math.min(el.scrollHeight + el.offsetHeight - el.clientHeight, maxPx)}px`;
    el.style.overflowY = el.scrollHeight > maxPx ? "auto" : "hidden";
  }, [ref, value, maxPx]);
}

/* ───────────── saving ───────────── */

/**
 * Brand edits are small, reversible and local to this page, so they show at once and roll back if the
 * server refuses them. Saves run one at a time, in the order they were made.
 */
function useBrandEdits(brand: BrandKit, client: StudioClient, onBrand: (brand: BrandKit) => void) {
  const [pending, setPending] = useState<Patch>({});
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [flash, setFlash] = useState<{ field: Field; at: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 1800);
    return () => window.clearTimeout(timer);
  }, [flash]);
  const settle = (field: Field, value: unknown) =>
    setPending((current) => {
      if (current[field] !== value) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  function save<K extends Field>(field: K, value: BrandKit[K], done: string): Promise<boolean> {
    setErrors((current) => ({ ...current, [field]: undefined }));
    setPending((current) => ({ ...current, [field]: value }));
    setAnnouncement("");
    const run = queue.current.then(async () => {
      try {
        const next = await client.updateBrand({ [field]: value, operationKey: crypto.randomUUID() } as UpdateBrandInput);
        onBrand(next);
        settle(field, value);
        // A later save that lands supersedes an earlier failure of the same field.
        setErrors((current) => ({ ...current, [field]: undefined }));
        setFlash({ field, at: Date.now() });
        setAnnouncement(done);
        return true;
      } catch (error) {
        settle(field, value);
        setErrors((current) => ({ ...current, [field]: messageOf(error) }));
        return false;
      }
    });
    queue.current = run;
    return run;
  }
  return { brand: { ...brand, ...pending } as BrandKit, errors, flash: flash?.field ?? null, announcement, save };
}

function Saved({ on }: { on: boolean }) {
  // The page's live region speaks the confirmation; this is the quiet visual echo of it.
  return (
    <span className="bk-saved" data-on={on || undefined} aria-hidden="true">
      <Check size={13} strokeWidth={2.25} />
      Saved
    </span>
  );
}

/* ───────────── click-to-edit text ───────────── */

function InlineText({
  label,
  value,
  placeholder,
  editable,
  maxLength,
  className,
  error,
  validate,
  onSave,
}: {
  label: string;
  value: string;
  placeholder: string;
  editable: boolean;
  maxLength: number;
  className: string;
  error?: string;
  /** Returns a message when the value cannot be saved as typed. */
  validate?: (next: string) => string | null;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [problem, setProblem] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const display = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  const id = useId();
  useGrow(input, editing ? draft : "", 320);
  useLayoutEffect(() => {
    const el = input.current;
    if (!editing || !el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  function start() {
    active.current = true;
    setDraft(value);
    setProblem("");
    setEditing(true);
  }
  function finish(commit: boolean, fromKeyboard: boolean) {
    if (!active.current) return;
    if (commit) {
      const next = draft.replace(/\s+/g, " ").trim();
      if (next !== value) {
        const message = validate?.(next) ?? null;
        // From the keyboard, a problem keeps the field open to fix; leaving the field simply cancels.
        if (message && fromKeyboard) return setProblem(message);
        if (!message) onSave(next);
      }
    }
    active.current = false;
    setEditing(false);
    setProblem("");
    if (fromKeyboard) requestAnimationFrame(() => display.current?.focus({ preventScroll: true }));
  }
  const message = problem || error;
  if (!editable)
    return (
      <span className={`bk-inline is-static ${className}`} data-empty={!value || undefined}>
        {value || placeholder}
      </span>
    );
  return (
    <span className={`bk-inline-wrap ${className}-wrap`}>
      {editing ? (
        <>
          <label className="sr-only" htmlFor={`${id}-input`}>{label}</label>
          <textarea
            id={`${id}-input`}
            ref={input}
            className={`bk-inline-input ${className}`}
            rows={1}
            value={draft}
            maxLength={maxLength}
            placeholder={placeholder}
            enterKeyHint="done"
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${problem ? `${id}-error ` : ""}${id}-hint`}
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem("");
            }}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                finish(true, true);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finish(false, true);
              }
            }}
            onBlur={() => finish(true, false)}
          />
          <span className="bk-hint" id={`${id}-hint`}>
            <kbd>Enter</kbd> to save · <kbd>Esc</kbd> to cancel
          </span>
        </>
      ) : (
        <button
          type="button"
          ref={display}
          className={`bk-inline ${className}`}
          data-empty={!value || undefined}
          aria-describedby={message ? `${id}-error` : undefined}
          onClick={start}
        >
          <span className="bk-inline-text">{value || placeholder}</span>
          <span className="sr-only">, edit {label.toLocaleLowerCase()}</span>
          <PenLine className="bk-inline-pen" size={14} aria-hidden="true" />
        </button>
      )}
      {message && (
        <span className="bk-error" id={`${id}-error`} role="alert">
          {message}
        </span>
      )}
    </span>
  );
}

/* ───────────── colour ───────────── */

function ColorPicker({ id, color, error, onPick, onClose }: { id: string; color: string; error?: string; onPick: (hex: string) => void; onClose: () => void }) {
  const [hex, setHex] = useState(color.replace("#", "").toUpperCase());
  const [problem, setProblem] = useState("");
  useEffect(() => setHex(color.replace("#", "").toUpperCase()), [color]);
  function commit() {
    const value = hex.trim().replace(/^#/, "");
    if (!/^[0-9a-f]{6}$/i.test(value)) return setProblem("Use six hex digits, like 5F6C66.");
    setProblem("");
    const next = `#${value.toUpperCase()}`;
    if (next !== color.toUpperCase()) onPick(next);
  }
  const message = problem || error;
  return (
    <div
      className="bk-colors"
      id={id}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="bk-swatches" role="group" aria-label="Brand colour">
        {SWATCHES.map((swatch) => {
          const chosen = same(swatch.hex, color);
          return (
            <button
              type="button"
              key={swatch.hex}
              className="bk-swatch"
              aria-pressed={chosen}
              aria-label={swatch.name}
              title={swatch.name}
              style={{ "--swatch": swatch.hex, "--swatch-ink": inkOn(swatch.hex) } as CSSProperties}
              onClick={() => {
                setProblem("");
                if (!chosen) onPick(swatch.hex);
              }}
            >
              <Check size={14} strokeWidth={2.5} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <div className="bk-hex">
        <label htmlFor={`${id}-hex`}>Hex</label>
        <span className="bk-hex-field">
          <span aria-hidden="true">#</span>
          <input
            id={`${id}-hex`}
            value={hex}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="characters"
            aria-invalid={problem ? true : undefined}
            aria-describedby={message ? `${id}-error` : undefined}
            onChange={(event) => {
              setHex(event.target.value.replace(/^#/, ""));
              setProblem("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
            }}
            onBlur={commit}
          />
        </span>
      </div>
      {message && (
        <p className="bk-error" id={`${id}-error`} role="alert">
          {message}
        </p>
      )}
    </div>
  );
}

/* ───────────── voice ───────────── */

function VoiceField({
  label,
  value,
  presets,
  limit,
  editable,
  saved,
  error,
  onSave,
}: {
  label: string;
  value: string;
  presets: string[];
  limit: number;
  editable: boolean;
  saved: boolean;
  error?: string;
  onSave: (next: string) => void;
}) {
  const id = useId();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const list = tokens(value);
  const custom = list.filter((token) => !presets.some((preset) => same(preset, token)));
  function apply(next: string) {
    if (next.length > limit) return setProblem(`Keep ${label.toLocaleLowerCase()} under ${limit} characters.`);
    setProblem("");
    onSave(next);
  }
  function add(keepOpen: boolean) {
    const token = draft.replace(/[,;\n]+/g, " ").trim();
    setDraft("");
    if (!keepOpen) setAdding(false);
    if (!token || list.some((part) => same(part, token))) return;
    apply([...list, token].join(", "));
  }
  const message = problem || error;
  return (
    <div className="bk-row">
      <div className="bk-row-label">
        <span id={`${id}-label`}>{label}</span>
        <Saved on={saved} />
      </div>
      {editable ? (
        <div className="bk-chips" role="group" aria-labelledby={`${id}-label`} aria-describedby={message ? `${id}-error` : undefined}>
          {[...presets, ...custom].map((chip) => (
            <button type="button" key={chip} className="bk-chip" aria-pressed={list.some((part) => same(part, chip))} onClick={() => apply(toggleToken(value, chip))}>
              {capital(chip)}
            </button>
          ))}
          {adding ? (
            <input
              className="bk-chip-input"
              autoFocus
              value={draft}
              maxLength={80}
              placeholder={label === "Tone" ? "Grounded" : "Festival visitors"}
              aria-label={`Add your own ${label.toLocaleLowerCase()}`}
              enterKeyHint="done"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  add(false);
                  requestAnimationFrame(() => addButton.current?.focus());
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setDraft("");
                  setAdding(false);
                  requestAnimationFrame(() => addButton.current?.focus());
                }
              }}
              onBlur={() => add(false)}
            />
          ) : (
            <button type="button" ref={addButton} className="bk-chip is-add" onClick={() => setAdding(true)}>
              <Plus size={14} aria-hidden="true" />
              Add your own
            </button>
          )}
        </div>
      ) : list.length ? (
        <ul className="bk-chips" aria-labelledby={`${id}-label`}>
          {list.map((chip) => (
            <li key={chip} className="bk-chip is-static">{capital(chip)}</li>
          ))}
        </ul>
      ) : (
        <p className="bk-row-empty">Not set</p>
      )}
      {message && (
        <p className="bk-error" id={`${id}-error`} role="alert">
          {message}
        </p>
      )}
    </div>
  );
}

/* ───────────── guardrails ───────────── */

function Guardrails({ rules, editable, saved, error, onSave }: { rules: string[]; editable: boolean; saved: boolean; error?: string; onSave: (next: string[], done: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ rule: string; index: number } | null>(null);
  const addInput = useRef<HTMLTextAreaElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  useGrow(addInput, draft, 200);
  useEffect(() => {
    if (!removed) return;
    const timer = window.setTimeout(() => setRemoved(null), 8000);
    return () => window.clearTimeout(timer);
  }, [removed]);
  const duplicate = (next: string, except = -1) => rules.some((rule, index) => index !== except && same(rule, next));
  const full = rules.length >= BRAND_LIMITS.rules;
  function add() {
    const next = draft.replace(/\s+/g, " ").trim();
    if (!next) return closeAdd(true);
    if (duplicate(next)) return setProblem("That guardrail is already on the list.");
    setDraft("");
    setProblem("");
    setFresh(next);
    setRemoved(null);
    onSave([...rules, next], "Guardrail added.");
    // Keep the field open for the next one, unless the list is now full.
    if (rules.length + 1 >= BRAND_LIMITS.rules) closeAdd(false);
  }
  function closeAdd(restoreFocus: boolean) {
    setAdding(false);
    setDraft("");
    setProblem("");
    if (restoreFocus) requestAnimationFrame(() => addButton.current?.focus());
  }
  function remove(index: number) {
    setRemoved({ rule: rules[index], index });
    onSave(rules.filter((_, position) => position !== index), "Guardrail removed.");
    requestAnimationFrame(() => undoButton.current?.focus());
  }
  function undo() {
    if (!removed) return;
    if (!duplicate(removed.rule) && rules.length < BRAND_LIMITS.rules) {
      const next = [...rules];
      next.splice(Math.min(removed.index, next.length), 0, removed.rule);
      onSave(next, "Guardrail restored.");
    }
    setRemoved(null);
    requestAnimationFrame(() => addButton.current?.focus());
  }
  return (
    <section className="bk-section" aria-labelledby="bk-rules-title">
      <div className="bk-section-head">
        <div>
          <h2 id="bk-rules-title">
            Guardrails <Saved on={saved} />
          </h2>
          <p>The Director drafts with these in view, and the editor points out wording that may break them.</p>
        </div>
        {editable && rules.length > 0 && (
          <span className="bk-count">
            {rules.length} of {BRAND_LIMITS.rules}
          </span>
        )}
      </div>
      {rules.length === 0 && !adding ? (
        <div className="bk-empty">
          <span className="bk-empty-mark" aria-hidden="true"><Check size={16} /></span>
          <div>
            <strong>No guardrails yet</strong>
            <p>Add the lines every draft must respect, like “No health claims” or “Mention the free trial only with its end date”.</p>
          </div>
          {editable && (
            <button type="button" ref={addButton} className="button secondary" onClick={() => setAdding(true)}>
              <Plus size={14} aria-hidden="true" />
              Add a guardrail
            </button>
          )}
        </div>
      ) : (
        <ul className="bk-rules">
          {rules.map((rule, index) => (
            // Position keys keep focus on a row while its text changes; the list is never reordered.
            <li key={index} data-new={rule === fresh || undefined}>
              <span className="bk-rule-mark" aria-hidden="true"><Check size={12} strokeWidth={2.25} /></span>
              <InlineText
                label="Guardrail"
                value={rule}
                placeholder=""
                editable={editable}
                maxLength={BRAND_LIMITS.rule}
                className="bk-rule-text"
                validate={(next) => (!next ? "A guardrail can’t be empty. Use Remove to delete it." : duplicate(next, index) ? "That guardrail is already on the list." : null)}
                onSave={(next) => onSave(rules.map((entry, position) => (position === index ? next : entry)), "Guardrail saved.")}
              />
              {editable && (
                <button type="button" className="icon-button bk-rule-remove" aria-label={`Remove guardrail: ${rule}`} title="Remove" onClick={() => remove(index)}>
                  <X size={15} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
          {editable && (adding ? (
            <li className="bk-rule-new">
              <span className="bk-rule-mark is-new" aria-hidden="true"><Plus size={12} strokeWidth={2.25} /></span>
              <span className="bk-inline-wrap bk-rule-text-wrap">
                <label className="sr-only" htmlFor="bk-rule-new">New guardrail</label>
                <textarea
                  id="bk-rule-new"
                  ref={addInput}
                  className="bk-inline-input bk-rule-text"
                  rows={1}
                  autoFocus
                  value={draft}
                  maxLength={BRAND_LIMITS.rule}
                  placeholder="Never promise results"
                  enterKeyHint="done"
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? "bk-rule-new-error bk-rule-new-hint" : "bk-rule-new-hint"}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setProblem("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      add();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      closeAdd(true);
                    }
                  }}
                  onBlur={() => {
                    if (draft.trim() && !problem) add();
                    if (!draft.trim()) closeAdd(false);
                  }}
                />
                <span className="bk-hint" id="bk-rule-new-hint">
                  <kbd>Enter</kbd> to add · <kbd>Esc</kbd> to close
                </span>
                {problem && (
                  <span className="bk-error" id="bk-rule-new-error" role="alert">
                    {problem}
                  </span>
                )}
              </span>
            </li>
          ) : full ? (
            <li className="bk-rule-full">That’s the most a brand kit holds. Remove one to add another.</li>
          ) : (
            <li className="bk-rule-add">
              <button type="button" ref={addButton} onClick={() => setAdding(true)}>
                <Plus size={15} aria-hidden="true" />
                Add a guardrail
              </button>
            </li>
          ))}
        </ul>
      )}
      {removed && (
        <p className="bk-undo">
          <span>Removed “{removed.rule}”.</span>
          <button type="button" ref={undoButton} className="text-button" onClick={undo}>
            Undo
          </button>
        </p>
      )}
      {error && (
        <p className="bk-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/* ───────────── sources ───────────── */

function SourceCard({
  source,
  uses,
  timezone,
  editable,
  fresh,
  onRemove,
}: {
  source: Source;
  uses: number;
  timezone: string;
  editable: boolean;
  fresh: boolean;
  onRemove: (source: Source, operationKey: string) => Promise<void>;
}) {
  const id = useId();
  const host = hostOf(source.url);
  const excerpt = useRef<HTMLParagraphElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    const el = excerpt.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [source.excerpt, expanded]);
  useEffect(() => {
    if (confirm) cancelButton.current?.focus({ preventScroll: true });
  }, [confirm]);
  const added = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short", year: "numeric" }).format(new Date(source.retrievedAt));
  function cancel() {
    setConfirm(null);
    setError("");
    requestAnimationFrame(() => removeButton.current?.focus({ preventScroll: true }));
  }
  async function remove() {
    if (!confirm || busy) return;
    setBusy(true);
    setError("");
    try {
      await onRemove(source, confirm);
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  }
  return (
    <article className="bk-source" aria-labelledby={`${id}-title`} data-new={fresh || undefined}>
      <span className="bk-source-mark" aria-hidden="true">{firstLetter(host ?? source.title, "S")}</span>
      <div className="bk-source-body">
        <h3 id={`${id}-title`}>{source.title}</h3>
        <p className="bk-source-meta">
          {host ? <span className="bk-source-host">{host}</span> : <span>Pasted text</span>}
          <span aria-hidden="true"> · </span>
          <span>Added {added}</span>
        </p>
        <p className="bk-source-excerpt" id={`${id}-excerpt`} ref={excerpt} data-expanded={expanded || undefined}>
          {source.excerpt}
        </p>
        {(clamped || expanded) && (
          <button type="button" className="bk-more" aria-expanded={expanded} aria-controls={`${id}-excerpt`} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show less" : "Show more"}
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      <footer className="bk-source-foot">
        {confirm ? (
          <div className="bk-confirm" role="group" aria-label={`Remove ${source.title}`}>
            <p>
              Remove this source?{uses > 0 ? ` ${drafts(uses)} will stop citing it.` : ""} You can add it again later.
            </p>
            <div>
              <button type="button" ref={cancelButton} className="button secondary" disabled={busy} onClick={cancel}>
                Keep source
              </button>
              <button type="button" className="button bk-danger" disabled={busy} onClick={() => void remove()}>
                {busy ? "Removing…" : "Remove source"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <span className="bk-source-uses">
              {[uses > 0 ? `Used by ${drafts(uses)}` : "", source.permittedAssetIds.length > 0 ? assets(source.permittedAssetIds.length) : ""].filter(Boolean).join(" · ")}
            </span>
            <span className="bk-source-actions">
              {source.url && (
                <a className="button secondary bk-small" href={source.url} target="_blank" rel="noreferrer">
                  Open
                  <ArrowUpRight size={13} aria-hidden="true" />
                  <span className="sr-only"> {source.title} in a new tab</span>
                </a>
              )}
              {editable && (
                <button type="button" ref={removeButton} className="button bk-small bk-quiet" onClick={() => setConfirm(crypto.randomUUID())}>
                  Remove<span className="sr-only"> {source.title}</span>
                </button>
              )}
            </span>
          </>
        )}
        {error && (
          <p className="bk-error" role="alert">
            {error}
          </p>
        )}
      </footer>
    </article>
  );
}

function AddSourceSheet({ campaign, client, onClose, onAdded }: { campaign: Campaign; client: StudioClient; onClose: () => void; onAdded: (next: Campaign, sourceId: string | null) => void }) {
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [problems, setProblems] = useState<{ title?: string; link?: string; excerpt?: string }>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // On a phone the keyboard would cover the sheet as it opens, so only a fine pointer gets focus here.
    if (matchMedia("(pointer: fine)").matches) titleInput.current?.focus({ preventScroll: true });
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const { url, ok } = normalizeLink(link);
    if (url && ok) setLink(url);
    const next = { title: title.replace(/\s+/g, " ").trim(), url: ok ? url : null, excerpt: excerpt.trim() };
    const found = {
      title: next.title ? undefined : "Give the source a title, like “Press release, March 2026”.",
      link: ok ? undefined : "Use a full web address, like https://example.com/press, without a username or password.",
      excerpt: next.excerpt ? undefined : "Paste the text Faceful may use. Drafts can’t read the link.",
    };
    setProblems(found);
    const first = found.title ? "bk-source-title" : found.link ? "bk-source-link" : found.excerpt ? "bk-source-text" : null;
    if (first) return document.getElementById(first)?.focus();
    // One key per distinct attempt: retrying after an interrupted response cannot add the source twice.
    const payload = JSON.stringify(next);
    if (attempt.current?.payload !== payload) attempt.current = { payload, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const before = new Set(campaign.sources.map((source) => source.id));
      const updated = await client.addSource({ campaignId: campaign.id, ...next, operationKey: attempt.current.key });
      onAdded(updated, updated.sources.find((source) => !before.has(source.id))?.id ?? null);
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  }
  const remaining = SOURCE_LIMITS.excerpt - excerpt.length;
  return (
    <Modal title="Add a source" onClose={onClose}>
      <form className="bk-sheet" onSubmit={(event) => void submit(event)} noValidate>
        <p className="bk-sheet-lead">
          For <strong>{campaign.title}</strong>
        </p>
        <div className="field">
          <label htmlFor="bk-source-title">Title</label>
          <input
            id="bk-source-title"
            ref={titleInput}
            value={title}
            maxLength={SOURCE_LIMITS.title}
            placeholder="Press release, March 2026"
            autoComplete="off"
            aria-invalid={problems.title ? true : undefined}
            aria-describedby={problems.title ? "bk-source-title-error" : undefined}
            onChange={(event) => {
              setTitle(event.target.value);
              setProblems((current) => ({ ...current, title: undefined }));
            }}
          />
          {problems.title && <small className="bk-error" id="bk-source-title-error">{problems.title}</small>}
        </div>
        <div className="field">
          <label htmlFor="bk-source-link">
            Link <span>Optional</span>
          </label>
          <input
            id="bk-source-link"
            type="url"
            inputMode="url"
            value={link}
            maxLength={SOURCE_LIMITS.url}
            placeholder="https://example.com/press"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problems.link ? true : undefined}
            aria-describedby={problems.link ? "bk-source-link-error" : undefined}
            onChange={(event) => {
              setLink(event.target.value);
              setProblems((current) => ({ ...current, link: undefined }));
            }}
            onBlur={() => {
              const { url, ok } = normalizeLink(link);
              if (url && ok) setLink(url);
            }}
          />
          {problems.link && <small className="bk-error" id="bk-source-link-error">{problems.link}</small>}
        </div>
        <div className="field">
          <label htmlFor="bk-source-text">
            Paste the text Faceful may use
            <span className="bk-counter" aria-hidden={remaining > 500 || undefined}>
              {remaining <= 500 ? `${remaining.toLocaleString("en")} left` : `${SOURCE_LIMITS.excerpt.toLocaleString("en")} max`}
            </span>
          </label>
          <textarea
            id="bk-source-text"
            className="bk-sheet-text"
            rows={8}
            value={excerpt}
            maxLength={SOURCE_LIMITS.excerpt}
            placeholder="BeWell helps festival visitors plan their day: explore activities, choose interests and save sessions."
            aria-invalid={problems.excerpt ? true : undefined}
            aria-describedby={`bk-source-note${problems.excerpt ? " bk-source-text-error" : ""}`}
            onChange={(event) => {
              setExcerpt(event.target.value);
              setProblems((current) => ({ ...current, excerpt: undefined }));
            }}
          />
          {problems.excerpt && <small className="bk-error" id="bk-source-text-error">{problems.excerpt}</small>}
        </div>
        <p className="bk-sheet-note" id="bk-source-note">
          <Link2 size={14} aria-hidden="true" />
          <span>Links are references only — Faceful never fetches them. Drafts use only the text you paste.</span>
        </p>
        {error && <Notice error>{error}</Notice>}
        <footer className="modal-actions bk-sheet-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? "Adding…" : "Add source"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function Sources({
  context,
  client,
  campaign,
  campaigns,
  editable,
  onCampaign,
  onSelectProject,
  onStartProject,
  announce,
}: {
  context: StudioContext;
  client: StudioClient;
  campaign: Campaign | null;
  campaigns: Campaign[];
  editable: boolean;
  onCampaign: (next: Campaign) => void;
  onSelectProject: (id: string) => void;
  onStartProject: () => void;
  announce: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const emptyAddButton = useRef<HTMLButtonElement>(null);
  const sources = campaign?.sources ?? [];
  async function remove(source: Source, operationKey: string) {
    if (!campaign) return;
    const next = await client.removeSource({ campaignId: campaign.id, sourceId: source.id, operationKey });
    onCampaign(next);
    announce(`Removed “${source.title}”.`);
    requestAnimationFrame(() => (addButton.current ?? emptyAddButton.current)?.focus({ preventScroll: true }));
  }
  const addAction = (ref: typeof addButton, className: string) =>
    editable && sources.length < SOURCE_LIMITS.perProject ? (
      <button type="button" ref={ref} className={className} onClick={() => setAdding(true)}>
        <Plus size={14} aria-hidden="true" />
        Add source
      </button>
    ) : null;
  return (
    <section className="bk-section" aria-labelledby="bk-sources-title">
      <div className="bk-section-head">
        <div>
          <h2 id="bk-sources-title">Sources</h2>
          {campaign && (
            <p className="bk-project">
              <span>For</span>
              {campaigns.length > 1 ? (
                <span className="bk-project-pick">
                  <select aria-label="Project" value={campaign.id} onChange={(event) => onSelectProject(event.target.value)}>
                    {campaigns.map((entry) => (
                      <option key={entry.id} value={entry.id}>{entry.title}</option>
                    ))}
                  </select>
                  <ChevronDown size={14} aria-hidden="true" />
                </span>
              ) : (
                <strong>{campaign.title}</strong>
              )}
            </p>
          )}
        </div>
        {sources.length > 0 && addAction(addButton, "button secondary bk-add")}
      </div>
      {!campaign ? (
        <div className="bk-empty">
          <span className="bk-empty-mark" aria-hidden="true"><FileText size={16} /></span>
          <div>
            <strong>No project open</strong>
            <p>Sources belong to a project. Open one to see the text its drafts may use, or start a new video.</p>
          </div>
          <button type="button" className="button secondary" onClick={onStartProject}>
            Create a video
          </button>
        </div>
      ) : sources.length === 0 ? (
        <div className="bk-empty">
          <span className="bk-empty-mark" aria-hidden="true"><FileText size={16} /></span>
          <div>
            <strong>No sources yet</strong>
            <p>Add a press release, a product page or notes from the founder. Faceful drafts from the text you paste, never from the link.</p>
          </div>
          {addAction(emptyAddButton, "button secondary")}
        </div>
      ) : (
        <div className="bk-sources">
          {sources.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              uses={campaign.items.filter((item) => item.sourceIds.includes(source.id)).length}
              timezone={context.workspace.timezone}
              editable={editable}
              fresh={source.id === fresh}
              onRemove={remove}
            />
          ))}
        </div>
      )}
      {sources.length > 0 && <p className="bk-tip">To use a source in a rewrite, attach it in the Director chat.</p>}
      {campaign && editable && sources.length >= SOURCE_LIMITS.perProject && (
        <p className="bk-limit">A project holds up to {SOURCE_LIMITS.perProject} sources. Remove one to add another.</p>
      )}
      {campaign?.brief && (
        <details className="bk-brief">
          <summary>
            Project brief
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <p>{campaign.brief}</p>
          {campaign.companyContext?.missingInformation && (
            <p>
              <strong>Still missing:</strong> {campaign.companyContext.missingInformation}
            </p>
          )}
        </details>
      )}
      {adding && campaign && (
        <AddSourceSheet
          campaign={campaign}
          client={client}
          onClose={() => setAdding(false)}
          onAdded={(next, sourceId) => {
            onCampaign(next);
            setFresh(sourceId);
            setAdding(false);
            announce("Source added.");
          }}
        />
      )}
    </section>
  );
}

/* ───────────── page ───────────── */

export function Brand({
  context,
  client,
  campaign,
  campaigns,
  onBrand,
  onCampaign,
  onSelectProject,
  onStartProject,
}: {
  context: StudioContext;
  client: StudioClient;
  /** The project currently open in the studio, whose sources are shown. */
  campaign: Campaign | null;
  campaigns: Campaign[];
  /** The server's brand kit after a save; the studio keeps its context in step. */
  onBrand: (brand: BrandKit) => void;
  /** The server's project after a source was added or removed. */
  onCampaign: (campaign: Campaign) => void;
  onSelectProject: (id: string) => void;
  onStartProject: () => void;
}) {
  // A UI convenience only: the engine checks content:edit on every save.
  const editable = context.principal.scopes.includes("content:edit");
  const edits = useBrandEdits(context.brand, client, onBrand);
  const { brand, errors, flash, save } = edits;
  const [colorOpen, setColorOpen] = useState(false);
  const [sourceNote, setSourceNote] = useState("");
  const markButton = useRef<HTMLButtonElement>(null);
  const swatch = SWATCHES.find((entry) => same(entry.hex, brand.color));
  const ink = inkOn(brand.color);
  const announcement = [edits.announcement, sourceNote].filter(Boolean).join(" ");
  const closeColors = () => {
    setColorOpen(false);
    requestAnimationFrame(() => markButton.current?.focus({ preventScroll: true }));
  };
  const markStyle = { "--brand": /^#[0-9a-f]{6}$/i.test(brand.color) ? brand.color : "#5F6C66", "--brand-ink": ink } as CSSProperties;
  return (
    <div className="bk">
      <header className="bk-intro">
        <h1>Brand kit</h1>
        <p>Every draft starts from this. Faceful and your agent both use it.</p>
        {!editable && (
          <p className="bk-readonly">
            <Lock size={13} aria-hidden="true" />
            View only. A workspace owner or editor can change it.
          </p>
        )}
      </header>

      <section className="bk-identity" aria-label="Brand">
        <div className="bk-identity-main">
          <div className="bk-mark-cell">
            {editable ? (
              <button
                type="button"
                ref={markButton}
                className="bk-mark"
                style={markStyle}
                aria-expanded={colorOpen}
                aria-controls="bk-colors"
                title="Change brand colour"
                onClick={() => setColorOpen(!colorOpen)}
              >
                <span aria-hidden="true">{firstLetter(brand.name, "F")}</span>
                <span className="sr-only">Brand colour: {swatch?.name ?? brand.color}. Change colour</span>
                <span className="bk-mark-badge" aria-hidden="true"><Palette size={12} /></span>
              </button>
            ) : (
              <span className="bk-mark" style={markStyle} aria-hidden="true">
                <span>{firstLetter(brand.name, "F")}</span>
              </span>
            )}
            <Saved on={flash === "name" || flash === "description" || flash === "color"} />
          </div>
          <div className="bk-identity-text">
            <div className="bk-line">
              <InlineText
                label="Brand name"
                value={brand.name}
                placeholder="Name your brand"
                editable={editable}
                maxLength={BRAND_LIMITS.name}
                className="bk-name"
                error={errors.name}
                validate={(next) => (next ? null : "Give the brand a name.")}
                onSave={(next) => void save("name", next, "Brand name saved.")}
              />
            </div>
            <div className="bk-line">
              <InlineText
                label="Description"
                value={brand.description}
                placeholder={editable ? "Add one line about what the brand does" : "No description yet"}
                editable={editable}
                maxLength={BRAND_LIMITS.description}
                className="bk-desc"
                error={errors.description}
                onSave={(next) => void save("description", next, "Description saved.")}
              />
            </div>
          </div>
        </div>
        {editable && colorOpen && (
          <ColorPicker id="bk-colors" color={brand.color} error={errors.color} onPick={(hex) => void save("color", hex, "Brand colour saved.")} onClose={closeColors} />
        )}
        {errors.color && !colorOpen && (
          <p className="bk-error" role="alert">
            {errors.color}
          </p>
        )}
      </section>

      <section className="bk-section" aria-labelledby="bk-voice-title">
        <div className="bk-section-head">
          <div>
            <h2 id="bk-voice-title">Voice</h2>
            <p>How drafts should sound, and who they speak to.</p>
          </div>
        </div>
        <div className="bk-group">
          <VoiceField
            label="Tone"
            value={brand.tone}
            presets={TONES}
            limit={BRAND_LIMITS.tone}
            editable={editable}
            saved={flash === "tone"}
            error={errors.tone}
            onSave={(next) => void save("tone", next, "Tone saved.")}
          />
          <VoiceField
            label="Audience"
            value={brand.audience}
            presets={AUDIENCES}
            limit={BRAND_LIMITS.audience}
            editable={editable}
            saved={flash === "audience"}
            error={errors.audience}
            onSave={(next) => void save("audience", next, "Audience saved.")}
          />
        </div>
      </section>

      <Guardrails rules={brand.rules} editable={editable} saved={flash === "rules"} error={errors.rules} onSave={(next, done) => void save("rules", next, done)} />

      <Sources
        context={context}
        client={client}
        campaign={campaign}
        campaigns={campaigns}
        editable={editable}
        onCampaign={onCampaign}
        onSelectProject={onSelectProject}
        onStartProject={onStartProject}
        announce={(message) => {
          // Cleared first, so the same confirmation twice in a row is still spoken.
          setSourceNote("");
          requestAnimationFrame(() => setSourceNote(message));
        }}
      />

      <p className="bk-footnote">
        Sources and links don’t grant media rights or permission to publish.
        {campaign?.id === "fixture-bewell-week" && " Quintessential is an unofficial demo agency; no endorsement is implied."}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
