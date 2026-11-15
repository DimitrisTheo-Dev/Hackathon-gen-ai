import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { ArrowRight, Check, Globe, Package, RefreshCw, X } from "lucide-react";
import { BRAND_LIMITS, type Brand as BrandKit, type BrandDraft, type UpdateBrandInput } from "@castroom/contracts";
import { ApiError, type StudioClient } from "../data/client";
import "../brand-draft.css";

/**
 * "Have a website? Draft this from it." The engine reads one public page and proposes fields; nothing is saved
 * until the person picks fields and applies them, through the same update_brand save as every other edit.
 * A field that already has a value is never ticked for them, so nothing is overwritten silently.
 */

type Field = "name" | "description" | "tone" | "audience" | "color" | "rules";
const FIELDS: Array<{ id: Field; label: string }> = [
  { id: "name", label: "Name" },
  { id: "description", label: "Description" },
  { id: "tone", label: "Tone" },
  { id: "audience", label: "Audience" },
  { id: "color", label: "Colour" },
  { id: "rules", label: "Guardrails" },
];
type Value = string | string[];
const empty = (value: Value) => (Array.isArray(value) ? value.length === 0 : !value.trim());
const sameValue = (a: Value, b: Value) => JSON.stringify(a).toLocaleLowerCase() === JSON.stringify(b).toLocaleLowerCase();
const languageName = (code: string | null) => {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? null;
  } catch {
    return null;
  }
};
/** Guardrails are added to the ones already there (never replace them), without repeats, up to the limit. */
function mergedRules(current: string[], proposed: string[]) {
  const next = [...current];
  for (const rule of proposed) if (next.length < BRAND_LIMITS.rules && !next.some((seen) => seen.toLocaleLowerCase() === rule.toLocaleLowerCase())) next.push(rule);
  return next;
}
function proposedValue(draft: BrandDraft, field: Field, brand: BrandKit): Value | null {
  if (field === "rules") {
    const added = mergedRules(brand.rules, draft.proposal.rules).slice(brand.rules.length);
    return added.length ? added : null;
  }
  const value = draft.proposal[field];
  return value && !sameValue(value, brand[field]) ? value : null;
}
/** The early check the engine repeats: something with a dot in it. A bare domain is fine; https:// is added there. */
function addressProblem(value: string) {
  const text = value.trim();
  if (!text) return "Paste your website’s address.";
  if (/\s/.test(text.replace(/^\s+|\s+$/g, ""))) return "A website address has no spaces. Try something like example.com.";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !text.split("/")[0].includes(".")) return "Add the full domain, like example.com.";
  return null;
}
const shownAddress = (value: string) => value.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");

function Swatch({ hex }: { hex: string }) {
  return <span className="bkd-swatch" style={{ "--swatch": hex } as CSSProperties} aria-hidden="true" />;
}
function Shown({ field, value }: { field: Field; value: Value }) {
  if (empty(value)) return <p className="bkd-empty">Empty</p>;
  if (Array.isArray(value)) return <ul className="bkd-list">{value.map((rule) => <li key={rule}>{rule}</li>)}</ul>;
  if (field === "color") return <p className="bkd-color"><Swatch hex={value} />{value.toUpperCase()}</p>;
  return <p>{value}</p>;
}

export function BrandDraftAssist({ brand, client, firstRun, onBrand }: {
  brand: BrandKit;
  client: StudioClient;
  /** Nothing in the brand kit yet: the assist is the first thing offered, not a quiet option. */
  firstRun: boolean;
  onBrand: (brand: BrandKit) => void;
}) {
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState("");
  const [failure, setFailure] = useState<{ message: string; retryAt: number | null } | null>(null);
  const [busy, setBusy] = useState<"reading" | "applying" | null>(null);
  const [draft, setDraft] = useState<BrandDraft | null>(null);
  const [picked, setPicked] = useState<Set<Field>>(new Set());
  const [changed, setChanged] = useState("");
  const [done, setDone] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const attempt = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const review = useRef<HTMLElement>(null);
  const waitSeconds = failure?.retryAt ? Math.max(0, Math.ceil((failure.retryAt - now) / 1000)) : 0;
  useEffect(() => {
    if (!waitSeconds) return;
    const timer = window.setTimeout(() => setNow(Date.now()), 1000);
    return () => window.clearTimeout(timer);
  }, [waitSeconds, now]);

  const rows = draft ? FIELDS.flatMap(({ id, label }) => {
    const proposed = proposedValue(draft, id, brand);
    return proposed === null ? [] : [{ id, label, current: id === "rules" ? brand.rules : brand[id], proposed }];
  }) : [];
  const count = rows.filter((row) => picked.has(row.id)).length;
  const matching = draft ? FIELDS.filter(({ id }) => id !== "rules" && draft.proposal[id] && sameValue(draft.proposal[id] as string, brand[id])).map(({ label }) => label.toLocaleLowerCase()) : [];

  async function read(event?: FormEvent) {
    event?.preventDefault();
    const issue = addressProblem(address);
    setProblem(issue ?? "");
    setFailure(null);
    if (issue) {
      input.current?.focus();
      return;
    }
    const mine = ++attempt.current;
    setBusy("reading");
    setDraft(null);
    setChanged("");
    setDone("");
    try {
      const next = await client.draftBrandFromWebsite({ url: address.trim(), operationKey: crypto.randomUUID() });
      if (mine !== attempt.current) return;
      setDraft(next);
      // Empty fields are ticked; anything the person already wrote is left alone unless they tick it.
      setPicked(new Set(FIELDS.filter(({ id }) => {
        const proposed = proposedValue(next, id, brand);
        return proposed !== null && (id === "rules" || empty(brand[id]));
      }).map(({ id }) => id)));
      requestAnimationFrame(() => review.current?.focus({ preventScroll: false }));
    } catch (error) {
      if (mine !== attempt.current) return;
      const message = error instanceof Error && error.message ? error.message : "Faceful couldn’t read that site. Check the address and try again.";
      if (error instanceof ApiError && error.code === "validation_error") {
        setProblem(message);
        input.current?.focus();
      } else if (error instanceof ApiError && error.code === "quota_exceeded") {
        const seconds = error.retryAfterSeconds ?? 30;
        setNow(Date.now());
        setFailure({ message: "You’ve drafted a few times in a row. Wait a moment before trying again.", retryAt: Date.now() + seconds * 1000 });
      } else if (error instanceof ApiError && error.code === "forbidden") {
        setFailure({ message: "Only workspace owners and editors can draft the brand kit.", retryAt: null });
      } else setFailure({ message, retryAt: null });
    } finally {
      if (mine === attempt.current) setBusy(null);
    }
  }
  function cancel() {
    attempt.current++;
    setBusy(null);
  }
  function close() {
    setDraft(null);
    setChanged("");
    requestAnimationFrame(() => input.current?.focus());
  }
  async function apply() {
    if (!draft) return;
    const chosen = rows.filter((row) => picked.has(row.id));
    if (!chosen.length) return;
    setBusy("applying");
    setChanged("");
    try {
      // A compare before the save: if the brand kit changed since this review was shown, show the new values first.
      const latest = (await client.getContext()).brand;
      if (chosen.some((row) => !sameValue(row.id === "rules" ? latest.rules : latest[row.id], row.current))) {
        onBrand(latest);
        setChanged("Your brand kit changed while you were reviewing. Check the updated “Now” values, then apply again.");
        return;
      }
      const patch: Record<string, unknown> = { operationKey: crypto.randomUUID() };
      for (const row of chosen) patch[row.id] = row.id === "rules" ? mergedRules(latest.rules, row.proposed as string[]) : row.proposed;
      const saved = await client.updateBrand(patch as UpdateBrandInput);
      onBrand(saved);
      const names = chosen.map((row) => row.label.toLocaleLowerCase());
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
      setDone(`Applied ${list} from ${draft.source.host}. You can still edit anything below.`);
      setDraft(null);
      setAddress("");
    } catch (error) {
      setChanged(error instanceof Error && error.message ? error.message : "Couldn’t save. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  const language = languageName(draft?.source.language ?? null);
  const writer = draft?.writer === "ai" ? `Written by AI from ${draft.source.host}${language ? `, in ${language} like the site` : ""}.` : `Taken from what ${draft?.source.host} states about itself.`;
  return (
    <>
      <section className={`bkd ${firstRun ? "is-first" : ""}`} aria-labelledby="bkd-title">
        <form className="bkd-form" noValidate onSubmit={read} aria-busy={busy === "reading"}>
          <div className="bkd-copy">
            <span className="bkd-mark" aria-hidden="true"><Globe size={firstRun ? 18 : 15} /></span>
            <div>
              <h2 id="bkd-title">{firstRun ? "Start from your website" : "Have a website? Draft this from it."}</h2>
              <p>{firstRun ? "Faceful reads your home page and suggests a name, description, voice and colour. You choose what to keep." : "Faceful suggests fields from your home page. Nothing changes until you choose."}</p>
            </div>
          </div>
          <div className="bkd-row">
            <label className="sr-only" htmlFor="bkd-url">Website address</label>
            <input
              ref={input}
              id="bkd-url"
              className="field"
              type="text"
              inputMode="url"
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="yourbusiness.com"
              value={address}
              maxLength={2048}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? "bkd-url-problem" : undefined}
              disabled={busy !== null}
              onChange={(event) => {
                setAddress(event.target.value);
                if (problem) setProblem("");
              }}
            />
            <button className="button primary bkd-go" disabled={busy !== null || waitSeconds > 0}>
              {busy === "reading" ? <><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>Reading…</> : <>Draft<ArrowRight size={14} aria-hidden="true" /></>}
            </button>
          </div>
          {problem && <p className="bk-error" id="bkd-url-problem" role="alert">{problem}</p>}
          {busy === "reading" && (
            <p className="bkd-status" role="status">
              Reading {shownAddress(address)}. This can take up to half a minute.
              <button type="button" className="text-button" onClick={cancel}>Cancel</button>
            </p>
          )}
          <p className="bkd-done" role="status" data-on={done ? true : undefined}>{done && <><Check size={14} aria-hidden="true" />{done}</>}</p>
          {failure && (
            <div className="bkd-problem" role="alert">
              <div>
                <strong>Couldn’t draft from {shownAddress(address) || "that site"}</strong>
                <p>{failure.message}</p>
              </div>
              <button type="button" className="button secondary" disabled={waitSeconds > 0 || busy !== null} onClick={() => void read()}>
                <RefreshCw size={14} aria-hidden="true" />
                {waitSeconds > 0 ? `Try again in ${waitSeconds}s` : "Try again"}
              </button>
            </div>
          )}
        </form>
      </section>

      {draft && (
        <section ref={review} tabIndex={-1} className="bkd-review" aria-labelledby="bkd-review-title">
          <header className="bkd-review-head">
            <div>
              <h2 id="bkd-review-title">Suggestions from {draft.source.host}</h2>
              <p>{writer} Nothing is saved until you apply it.</p>
            </div>
            <button type="button" className="icon-button" aria-label="Discard suggestions" title="Discard" onClick={close}><X size={16} /></button>
          </header>
          {draft.note && <p className="bkd-note">{draft.note}</p>}
          {rows.length ? (
            <ul className="bkd-fields">
              {rows.map((row) => {
                const on = picked.has(row.id);
                const replaces = row.id !== "rules" && !empty(row.current);
                return (
                  <li key={row.id} data-on={on || undefined}>
                    <label className="bkd-pick">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setPicked((current) => {
                          const next = new Set(current);
                          if (next.has(row.id)) next.delete(row.id);
                          else next.add(row.id);
                          return next;
                        })}
                      />
                      <span>{row.label}</span>
                      <small>{row.id === "rules" ? `Adds ${row.proposed.length}` : replaces ? "Replaces yours" : "Fills an empty field"}</small>
                    </label>
                    <div className="bkd-compare">
                      <div className="bkd-now">
                        <small>{row.id === "rules" ? "Yours" : "Now"}</small>
                        <Shown field={row.id} value={row.current} />
                      </div>
                      <div className="bkd-new">
                        <small>{row.id === "rules" ? "Suggested additions" : "Suggested"}</small>
                        <Shown field={row.id} value={row.proposed} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="bkd-none">{matching.length ? "Your brand kit already matches what the site says." : "The page didn’t say enough to suggest anything. You can fill in the brand kit by hand below."}</p>
          )}
          {rows.length > 0 && matching.length > 0 && <p className="bkd-matching">Already the same as your site: {matching.join(", ")}.</p>}
          {draft.offerings.length > 0 && (
            <div className="bkd-offerings">
              <h3><Package size={14} aria-hidden="true" />Products and services on the site</h3>
              <p>Add the ones you sell under Products, with facts you approve. Faceful doesn’t add products for you.</p>
              <ul>
                {draft.offerings.map((offering) => <li key={offering.name} title={offering.description || undefined}>{offering.name}</li>)}
              </ul>
            </div>
          )}
          {changed && <p className="bk-error" role="alert">{changed}</p>}
          <footer className="bkd-review-foot">
            <p>
              Read {draft.source.characters.toLocaleString("en")} characters of text{draft.source.truncated ? ", from the start of a long page" : ""}.{" "}
              <a href={draft.source.url} target="_blank" rel="noreferrer noopener">Open the page</a>
            </p>
            <div>
              <button type="button" className="button secondary" onClick={close} disabled={busy === "applying"}>Discard</button>
              {rows.length > 0 && (
                <button type="button" className="button primary" disabled={!count || busy !== null} onClick={() => void apply()}>
                  {busy === "applying" ? "Applying…" : <><Check size={14} aria-hidden="true" />{count ? `Apply ${count} selected` : "Apply selected"}</>}
                </button>
              )}
            </div>
          </footer>
        </section>
      )}
    </>
  );
}
