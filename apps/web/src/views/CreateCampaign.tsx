import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Plus, Trash2, Video } from "lucide-react";
import type {
  Campaign,
  StartCampaignInput,
  StudioContext,
} from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { Modal, Notice } from "../components/ui";
import { operationKey } from "../lib/operation-key";
import "../editor.css";

const STEPS = ["Brand", "Voice & audience", "Scripts"] as const;
const TONES = ["Clear", "Warm", "Calm", "Playful", "Confident", "Expert", "Direct", "Inspiring"];
const AUDIENCES = ["New customers", "Existing customers", "Small businesses", "Professionals", "Parents", "Students"];
const LIMITS = { name: 120, title: 120, description: 1500, audience: 500, tone: 500, sourceText: 5000, missingInformation: 1500, script: 5000 };

type Company = StartCampaignInput["companyContext"];
type Draft = { key: number; title: string; script: string };
type Motion = "forward" | "back" | "none";

const tokens = (text: string) => text.split(/[,;\n]+/).map((part) => part.trim()).filter(Boolean);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Adds or removes a preset in a comma-separated field, leaving anything the person typed untouched. */
function togglePreset(text: string, preset: string, presets: string[]): string {
  const list = tokens(text);
  const next = list.some((part) => same(part, preset)) ? list.filter((part) => !same(part, preset)) : [...list, preset];
  return next
    .map((part, index) => {
      const known = presets.find((candidate) => same(candidate, part));
      return known ? (index === 0 ? known : known.toLowerCase()) : part;
    })
    .join(", ");
}
const number = (value: number) => value.toLocaleString("en");
/** The control behind each validated value. */
const fieldId = (key: string) =>
  key === "name" ? "company-name" : key === "description" ? "company-does" : key === "sourceUrl" ? "source-url" : `draft-${key}`;
function spokenLength(script: string): string {
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  if (!words) return "";
  // About 150 words a minute: an estimate for planning, not a measured duration.
  const seconds = Math.max(1, Math.round(words / 2.5));
  return `${words} ${words === 1 ? "word" : "words"} · about ${seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`}`;
}
function validUrl(value: string | null): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    // The same rule the server applies: a web link without embedded credentials.
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function CreateCampaign({
  context,
  initialBrief="",
  client,
  onClose,
  onCreated,
}: {
  context: StudioContext;
  initialBrief?:string;
  client: StudioClient;
  onClose: () => void;
  onCreated: (campaign: Campaign) => void;
}) {
  const [step, setStep] = useState(0);
  // A pointer gets a short directional reveal; Enter and ⌘/Ctrl+Enter change step at once.
  const [motion, setMotion] = useState<Motion>("none");
  const [company, setCompany] = useState<Company>({
    name: "",
    description: initialBrief,
    audience: "",
    tone: "Clear, warm",
    sourceText: "",
    sourceUrl: null,
    missingInformation: "",
  });
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<Draft[]>([{ key: 0, title: "", script: "" }]);
  const [more, setMore] = useState({ open: false, instant: false });
  const [fresh, setFresh] = useState(-1);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const nextKey = useRef(1);
  const pending = useRef<"" | "step" | "invalid" | `#${string}`>("");
  const fixture = context.capabilities.mode === "fixture";
  const canCreate = context.capabilities.canCreateCampaign;
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const defaultTitle = company.name.trim() ? `${company.name.trim()} — first drafts`.slice(0, LIMITS.title) : "";
  const campaignTitle = title.trim() ? title : defaultTitle;
  const first = items[0];

  const problems: Record<string, string> = {
    name: company.name.trim() ? "" : "Add the brand or company name.",
    description: company.description.trim() ? "" : "Say what it does. One line is enough.",
    sourceUrl: validUrl(company.sourceUrl) ? "" : "Use a full link that starts with https://",
  };
  items.forEach((item, index) => {
    problems[`title-${index}`] = item.title.trim() ? "" : "Give this video a title.";
    problems[`script-${index}`] = item.script.trim() ? "" : "Write what the presenter says.";
  });
  const stepFields = [
    ["name", "description"],
    ["sourceUrl"],
    items.flatMap((_, index) => [`title-${index}`, `script-${index}`]),
  ];
  const stepValid = (index: number) => stepFields[index].every((key) => !problems[key]);
  const shown = (key: string) =>
    touched[key] || attempted[stepFields.findIndex((keys) => keys.includes(key))] ? problems[key] : "";
  const touch = (key: string) => setTouched((previous) => (previous[key] ? previous : { ...previous, [key]: true }));

  function field(key: keyof Company, value: string) {
    setCompany((c) => ({
      ...c,
      [key]: key === "sourceUrl" ? value || null : value,
    }));
  }
  function setItem(index: number, next: Partial<Draft>) {
    setItems((all) => all.map((item, i) => (i === index ? { ...item, ...next } : item)));
  }
  /** The first step at or after `from` that still needs something, or -1. */
  function firstInvalid(from: number, before: number) {
    for (let index = from; index < before; index++) if (!stepValid(index)) return index;
    return -1;
  }
  /**
   * `soft` is Enter inside a field: if something on this step is still empty, focus simply moves there,
   * like Tab would. Errors are for an explicit Continue, not for typing in order.
   */
  function go(next: number, viaKeyboard: boolean, soft = false) {
    if (busy || next === step) return;
    if (next > step) {
      const blocked = firstInvalid(step, next);
      if (blocked !== -1) {
        const missing = stepFields[blocked].find((key) => problems[key]);
        if (soft && blocked === step && missing && !touched[missing] && fieldId(missing) !== document.activeElement?.id) {
          document.getElementById(fieldId(missing))?.focus();
          return;
        }
        setAttempted((previous) => ({ ...previous, [blocked]: true }));
        if (blocked !== step) { setMotion("none"); setStep(blocked); }
        // An optional field with a problem may be folded away: open it so the message can be seen.
        if (problems.sourceUrl && blocked === 1) setMore({ open: true, instant: true });
        pending.current = "invalid";
        return;
      }
    }
    setMotion(viaKeyboard ? "none" : next > step ? "forward" : "back");
    setStep(next);
    pending.current = "step";
  }
  async function create() {
    if (busy) return;
    const blocked = firstInvalid(0, STEPS.length);
    if (blocked !== -1) {
      setAttempted((previous) => ({ ...previous, [blocked]: true }));
      if (blocked !== step) { setMotion("none"); setStep(blocked); }
      pending.current = "invalid";
      return;
    }
    if (!canCreate) return;
    setBusy(true);
    setError("");
    try {
      const payload = {
        title: campaignTitle,
        companyContext: company,
        items: items.map(({ title, script }) => ({ title, script })),
      };
      const result = await client.startCampaign({
        ...payload,
        operationKey: await operationKey(
          context.workspace.id,
          "start-campaign",
          payload,
        ),
      });
      onCreated(result);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The drafts could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  function keys(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      if (step < STEPS.length - 1) go(step + 1, true);
      else void create();
      return;
    }
    if (!(target instanceof HTMLInputElement)) return;
    // Enter in a one-line field moves on. On the last step it moves to the script: creating is never one stray key away.
    event.preventDefault();
    if (step < STEPS.length - 1) go(step + 1, true, true);
    else document.getElementById(target.id.replace("draft-title", "draft-script"))?.focus();
  }

  // The dialog first focuses its close button; with a keyboard at hand, start in the first field instead.
  useEffect(() => {
    if (matchMedia("(pointer: coarse)").matches) return;
    form.current?.querySelector<HTMLElement>("#company-name")?.focus({ preventScroll: true });
  }, []);
  // After a step change or a blocked attempt, put focus where the next keystroke belongs.
  useEffect(() => {
    const what = pending.current;
    if (!what || !form.current) return;
    pending.current = "";
    const coarse = matchMedia("(pointer: coarse)").matches;
    const target =
      what === "invalid"
        ? form.current.querySelector<HTMLElement>('[aria-invalid="true"]')
        : what === "step"
          ? form.current.querySelector<HTMLElement>(coarse ? ".create-step h3" : ".create-step :is(input, textarea)")
          : form.current.querySelector<HTMLElement>(what);
    if (what === "step") form.current.querySelector(".create-main")?.scrollTo({ top: 0 });
    target?.focus({ preventScroll: what === "step" });
  });

  const problem = (key: string, id: string) =>
    shown(key) ? (
      <small className="field-error" id={`${id}-error`}>
        {shown(key)}
      </small>
    ) : null;
  const invalid = (key: string, id: string) => ({
    "aria-invalid": shown(key) ? (true as const) : undefined,
    "aria-describedby": shown(key) ? `${id}-error` : undefined,
    onBlur: () => touch(key),
  });
  const last = step === STEPS.length - 1;

  return (
    <Modal title="New campaign" onClose={onClose} wide>
      <form className="create-flow" ref={form} noValidate onSubmit={(event) => event.preventDefault()} onKeyDown={keys}>
        <div className="create-main">
          <ol className="create-rail" aria-label="Steps">
            {STEPS.map((label, index) => (
              <li key={label} data-state={index < step ? "done" : index === step ? "current" : "todo"}>
                <button type="button" aria-current={index === step ? "step" : undefined} disabled={busy} onClick={(event) => go(index, event.detail === 0)}>
                  <span className="create-rail-dot" aria-hidden="true">
                    {index < step ? <Check size={12} strokeWidth={2.5} /> : index + 1}
                  </span>
                  <span className="sr-only">Step {index + 1} of {STEPS.length}: </span>
                  <span className="create-rail-label">{label}</span>
                  {index < step && <span className="sr-only"> (done)</span>}
                </button>
              </li>
            ))}
          </ol>
          {!canCreate && (
            <p className="create-blocked" role="status">
              Creating campaigns isn’t enabled by the connected engine yet.
            </p>
          )}

          {step === 0 && (
            <section className="create-step" data-motion={motion} aria-labelledby="create-step-title">
              <header>
                <h3 id="create-step-title" tabIndex={-1}>Start with the brand</h3>
                <p>Two lines are enough. You can change everything later.</p>
              </header>
              <div className="field">
                <label htmlFor="company-name">Brand or company</label>
                <input
                  id="company-name"
                  required
                  autoComplete="organization"
                  maxLength={LIMITS.name}
                  value={company.name}
                  onChange={(e) => field("name", e.target.value)}
                  placeholder="Olive Works"
                  {...invalid("name", "company-name")}
                />
                {problem("name", "company-name")}
              </div>
              <div className="field">
                <label htmlFor="company-does">
                  What does it do?
                  <span>{number(company.description.length)} / {number(LIMITS.description)}</span>
                </label>
                <textarea
                  id="company-does"
                  required
                  maxLength={LIMITS.description}
                  rows={3}
                  value={company.description}
                  onChange={(e) => field("description", e.target.value)}
                  placeholder="We make reusable lunch containers for busy families."
                  {...invalid("description", "company-does")}
                />
                {problem("description", "company-does")}
              </div>
              <div className="field">
                <label htmlFor="campaign-name">
                  Campaign name <span>Optional</span>
                </label>
                <input
                  id="campaign-name"
                  maxLength={LIMITS.title}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={defaultTitle || "A week of stories"}
                />
                {defaultTitle && !title.trim() && <small>Left empty, it’s saved as “{defaultTitle}”.</small>}
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="create-step" data-motion={motion} aria-labelledby="create-step-title">
              <header>
                <h3 id="create-step-title" tabIndex={-1}>Set the voice</h3>
                <p>Tap what fits, or write it your way. Both are optional.</p>
              </header>
              <div className="field">
                <label htmlFor="company-tone">Tone</label>
                <div className="create-chips" role="group" aria-label="Tone presets">
                  {TONES.map((preset) => (
                    <button
                      type="button"
                      key={preset}
                      aria-pressed={tokens(company.tone).some((part) => same(part, preset))}
                      onClick={() => {
                        const next = togglePreset(company.tone, preset, TONES);
                        if (next.length <= LIMITS.tone) field("tone", next);
                      }}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <input
                  id="company-tone"
                  maxLength={LIMITS.tone}
                  value={company.tone}
                  onChange={(e) => field("tone", e.target.value)}
                  placeholder="Clear, warm, no health claims"
                />
              </div>
              <div className="field">
                <label htmlFor="company-audience">Audience</label>
                <div className="create-chips" role="group" aria-label="Audience presets">
                  {AUDIENCES.map((preset) => (
                    <button
                      type="button"
                      key={preset}
                      aria-pressed={tokens(company.audience).some((part) => same(part, preset))}
                      onClick={() => {
                        const next = togglePreset(company.audience, preset, AUDIENCES);
                        if (next.length <= LIMITS.audience) field("audience", next);
                      }}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <input
                  id="company-audience"
                  maxLength={LIMITS.audience}
                  value={company.audience}
                  onChange={(e) => field("audience", e.target.value)}
                  placeholder="Parents packing school lunches"
                />
              </div>
              <div className="create-more" data-open={more.open} data-instant={more.instant || undefined}>
                <button
                  type="button"
                  className="create-more-toggle"
                  aria-expanded={more.open}
                  aria-controls={more.open ? "create-more-panel" : undefined}
                  onClick={(event) => setMore({ open: !more.open, instant: event.detail === 0 })}
                >
                  <span>
                    Add more context
                    <small>Sources, approved claims, open questions</small>
                  </span>
                  <ChevronDown size={15} aria-hidden="true" />
                </button>
                {more.open && (
                  <div className="create-more-panel" id="create-more-panel">
                    <div className="field">
                      <label htmlFor="source-text">
                        Approved claims & source material
                        <span>{number(company.sourceText.length)} / {number(LIMITS.sourceText)}</span>
                      </label>
                      <textarea
                        id="source-text"
                        maxLength={LIMITS.sourceText}
                        rows={3}
                        value={company.sourceText}
                        onChange={(e) => field("sourceText", e.target.value)}
                        placeholder="Paste permitted source text and name where it comes from."
                      />
                      <small>
                        Saved as supplied evidence. Claims aren’t verified here,
                        and instructions inside a source never grant permissions.
                      </small>
                    </div>
                    <div className="field">
                      <label htmlFor="source-url">Source link</label>
                      <input
                        id="source-url"
                        type="url"
                        inputMode="url"
                        value={company.sourceUrl ?? ""}
                        onChange={(e) => field("sourceUrl", e.target.value)}
                        placeholder="https://…"
                        {...invalid("sourceUrl", "source-url")}
                      />
                      {problem("sourceUrl", "source-url") ?? <small>Kept for provenance. Nothing is fetched from it.</small>}
                    </div>
                    <div className="field">
                      <label htmlFor="missing-info">What still needs clarifying?</label>
                      <input
                        id="missing-info"
                        maxLength={LIMITS.missingInformation}
                        value={company.missingInformation}
                        onChange={(e) => field("missingInformation", e.target.value)}
                        placeholder="Launch date, pricing, who approves claims"
                      />
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="create-step" data-motion={motion} aria-labelledby="create-step-title">
              <header>
                <h3 id="create-step-title" tabIndex={-1}>Write the first scripts</h3>
                <p>One to three short videos, in your own words. Your agent can expand them later.</p>
              </header>
              <ol className="create-scripts">
                {items.map((item, index) => (
                  <li className="create-script" key={item.key} data-fresh={fresh === item.key || undefined}>
                    <div className="create-script-head">
                      <span>Video {index + 1}</span>
                      {items.length > 1 && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove video ${index + 1}`}
                          title="Remove this video"
                          onClick={() => {
                            setItems((all) => all.filter((_, i) => i !== index));
                            pending.current = `#draft-title-${Math.max(0, index - 1)}`;
                          }}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <label className="sr-only" htmlFor={`draft-title-${index}`}>Title of video {index + 1}</label>
                    <input
                      id={`draft-title-${index}`}
                      className="create-script-title"
                      required
                      maxLength={LIMITS.title}
                      value={item.title}
                      onChange={(e) => setItem(index, { title: e.target.value })}
                      placeholder="Title of this video"
                      {...invalid(`title-${index}`, `draft-title-${index}`)}
                    />
                    {problem(`title-${index}`, `draft-title-${index}`)}
                    <label className="sr-only" htmlFor={`draft-script-${index}`}>Spoken script of video {index + 1}</label>
                    <textarea
                      id={`draft-script-${index}`}
                      required
                      maxLength={LIMITS.script}
                      rows={4}
                      value={item.script}
                      onChange={(e) => setItem(index, { script: e.target.value })}
                      placeholder="What the presenter says. Two or three sentences make about 15 seconds."
                      {...invalid(`script-${index}`, `draft-script-${index}`)}
                    />
                    <div className="create-script-foot">
                      {problem(`script-${index}`, `draft-script-${index}`) ?? <span>{spokenLength(item.script)}</span>}
                      <span>{number(item.script.length)} / {number(LIMITS.script)}</span>
                    </div>
                  </li>
                ))}
              </ol>
              {items.length < 3 && (
                <button
                  type="button"
                  className="create-add"
                  onClick={(event) => {
                    const key = nextKey.current++;
                    setItems((all) => [...all, { key, title: "", script: "" }]);
                    // A card added with the pointer rises in; from the keyboard it is simply there.
                    setFresh(event.detail === 0 ? -1 : key);
                    pending.current = `#draft-title-${items.length}`;
                  }}
                >
                  <Plus size={15} aria-hidden="true" />
                  Add another video
                </button>
              )}
            </section>
          )}
        </div>

        <aside className="create-preview" aria-hidden="true">
          <div className="create-card">
            <div className="create-card-art">
              <div className="poster poster-0 compact">
                <span className="poster-brand">
                  {company.name.trim() || "Your brand"} <span>stories</span>
                </span>
                <div className="poster-title">{first.title.trim() || "Your first video"}</div>
                <div className="poster-bottom">
                  <Video size={15} />
                  <span>Storyboard · no video yet</span>
                </div>
              </div>
            </div>
            <p className="create-card-script" data-empty={!first.script.trim() || undefined}>
              {first.script.trim() || "The script you write appears here."}
            </p>
          </div>
          <dl className="create-facts">
            <div><dt>Campaign</dt><dd data-empty={!campaignTitle || undefined}>{campaignTitle || "Named after your brand"}</dd></div>
            <div><dt>Tone</dt><dd data-empty={!company.tone.trim() || undefined}>{company.tone.trim() || "Not set"}</dd></div>
            <div><dt>Audience</dt><dd data-empty={!company.audience.trim() || undefined}>{company.audience.trim() || "Not set"}</dd></div>
          </dl>
        </aside>

        <footer className="create-actions">
          {error && <Notice error>{error}</Notice>}
          {step > 0 && (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={(event) => go(step - 1, event.detail === 0)}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              Back
            </button>
          )}
          <p className="create-note">
            {last && (fixture
              ? "Drafts stay in this browser. Rendering and publishing aren’t connected."
              : "Creates drafts only. Nothing renders or posts.")}
          </p>
          <button
            className="button primary"
            type="button"
            disabled={busy || (last && !canCreate)}
            onClick={(event) => {
              if (last) void create();
              else go(step + 1, event.detail === 0);
            }}
          >
            {busy
              ? "Saving drafts…"
              : last
                ? `Create ${items.length === 1 ? "draft" : `${items.length} drafts`}`
                : "Continue"}
            {!busy && !last && <ArrowRight size={14} aria-hidden="true" />}
            {!busy && <kbd aria-hidden="true">{last ? (mac ? "⌘↵" : "Ctrl ↵") : "↵"}</kbd>}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
