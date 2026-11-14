import { useEffect, useRef, useState } from "react";
import { ArrowUp, CalendarDays, Check, ChevronRight, Folder, Grid2X2, Layers, MousePointer2, Paperclip, Plug, Plus, Search, Sparkles } from "lucide-react";

/**
 * A coded illustration of the real studio: Projects on the left, the storyboard canvas in the
 * middle, the AI Director chat on the right. It tells one short story in a loop:
 * prompt → the composer docks into the chat → drafts land → an edit becomes version 2 →
 * a posting time waits for approval → a connected agent adds a draft through MCP.
 *
 * It is an interface illustration with sample content. Nothing is rendered, scheduled or published,
 * and the markup never claims otherwise. Server-rendered HTML is the composed final frame, which is
 * also what reduced-motion visitors keep.
 */
const PROMPT = "Create a 15-second Reel for BeWell with a friendly Greek presenter, ready for Monday.";

/** [time in ms, step]. Steps only ever toggle classes; all motion is CSS transform/opacity. */
const TIMELINE: ReadonlyArray<readonly [number, number]> = [
  [0, 0], // home: centred composer
  [450, 1], // typing
  [2050, 2], // send pressed
  [2250, 3], // composer docks right, chat and canvas open, message lands
  [2850, 4], // drafts arrive, "Drafting…"
  [3850, 5], // "3 drafts ready"
  [4500, 6], // follow-up request
  [5050, 7], // reviewable change
  [5950, 8], // applied → version 2
  [6700, 9], // posting time proposed, needs approval
  [7500, 10], // agent cursor glides in
  [8200, 11], // agent's draft lands
  [9500, 12], // fade out
  [9800, 13], // rewind poses with transitions off
];
const LOOP_MS = 9950;
const TYPE_START = 450;
const TYPE_END = 1950;
const FINAL_STEP = 11;

const drafts = [
  { tone: "a", brand: "BeWell", words: ["Καλώς", "ήρθες."], title: "Καλώς ήρθες" },
  { tone: "b", brand: "BeWell", words: ["Η μέρα σου,", "όπως τη θες."], title: "Η μέρα σου" },
  { tone: "c", brand: "BeWell", words: ["Τα λέμε", "εκεί."], title: "Τα λέμε εκεί" },
] as const;

export function StudioDemo() {
  const [step, setStep] = useState(FINAL_STEP);
  const [typed, setTyped] = useState(PROMPT.length);
  const [motion, setMotion] = useState(false);
  const [visible, setVisible] = useState(false);
  const [held, setHeld] = useState(false);
  const figure = useRef<HTMLElement>(null);
  const aura = useRef<HTMLSpanElement>(null);
  const elapsed = useRef(LOOP_MS - 450);
  const playing = motion && visible && !held;

  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotion(!query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    // Plays only while it can be seen: in the viewport and in a foreground tab.
    const node = figure.current;
    if (!node) return;
    let inView = false;
    const sync = () => setVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); }, { threshold: 0.3 });
    observer.observe(node);
    document.addEventListener("visibilitychange", sync);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", sync); };
  }, []);

  useEffect(() => {
    // The light behind the window drifts a little against the pointer, so the window reads as an object in front of it.
    // Decorative, pointer-only, and eased frame by frame so it never snaps.
    const node = figure.current;
    const light = aura.current;
    if (!node || !light) return;
    const fine = matchMedia("(hover: hover) and (pointer: fine)");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let targetX = 0, targetY = 0, x = 0, y = 0;
    const step = () => {
      x += (targetX - x) * 0.1;
      y += (targetY - y) * 0.1;
      light.style.transform = `translate3d(${(-x * 28).toFixed(2)}px, ${(-y * 18).toFixed(2)}px, 0)`;
      frame = Math.abs(targetX - x) > 0.002 || Math.abs(targetY - y) > 0.002 ? requestAnimationFrame(step) : 0;
    };
    const follow = (event: PointerEvent) => {
      if (!fine.matches || reduced.matches) return;
      const bounds = node.getBoundingClientRect();
      targetX = (event.clientX - bounds.left) / bounds.width - 0.5;
      targetY = (event.clientY - bounds.top) / bounds.height - 0.5;
      if (!frame) frame = requestAnimationFrame(step);
    };
    const settle = () => {
      targetX = 0;
      targetY = 0;
      if (!frame) frame = requestAnimationFrame(step);
    };
    node.addEventListener("pointermove", follow);
    node.addEventListener("pointerleave", settle);
    return () => {
      node.removeEventListener("pointermove", follow);
      node.removeEventListener("pointerleave", settle);
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!motion) {
      // Reduced motion: hold the composed final frame.
      elapsed.current = LOOP_MS - 450;
      setStep(FINAL_STEP);
      setTyped(PROMPT.length);
      return;
    }
    if (!playing) return;
    const origin = Date.now() - elapsed.current;
    const tick = () => {
      let now = Date.now() - origin;
      if (now >= LOOP_MS) now %= LOOP_MS;
      elapsed.current = now;
      let next = 0;
      for (const [at, value] of TIMELINE) if (now >= at) next = value;
      setStep(next);
      setTyped(next === 0 || next === 13 ? 0 : now >= TYPE_END ? PROMPT.length : Math.max(0, Math.round(((now - TYPE_START) / (TYPE_END - TYPE_START)) * PROMPT.length)));
    };
    tick();
    const timer = window.setInterval(tick, 40);
    return () => { window.clearInterval(timer); elapsed.current = (Date.now() - origin) % LOOP_MS; };
  }, [motion, playing]);

  const live = step <= FINAL_STEP;
  const at = (from: number) => (live && step >= from ? "is-in" : "");
  const docked = step >= 3 && step !== 13;
  const latest = step >= 9 ? "schedule" : step >= 7 ? "proposal" : step >= 6 ? "ask" : step >= 5 ? "saved" : step >= 3 ? "working" : "";
  const rootClass = ["fd", docked ? "is-docked" : "is-home", step === 2 ? "is-sending" : "", step >= 11 && live ? "has-agent-card" : "", step === 12 ? "is-fading" : "", step === 13 ? "is-rewinding" : ""].filter(Boolean).join(" ");

  return (
    <figure
      ref={figure}
      className="landing-demo"
      aria-label="Animated illustration of the Faceful studio. A typed request becomes three editable drafts beside the AI Director chat. An edit is saved as version 2, a posting time waits for approval, and a connected agent adds a draft."
      data-playing={playing ? "true" : "false"}
      data-step={step}
      onClick={(event) => { if (motion && !(event.target as Element).closest("button")) setHeld((value) => !value); }}
    >
      <span ref={aura} className="landing-demo-aura" aria-hidden="true" />
      <div className="landing-demo-frame">
        <div className="landing-demo-titlebar" aria-hidden="true">
          <span className="landing-window-controls"><i /><i /><i /></span>
          <span className="landing-demo-address">faceful.vercel.app/studio</span>
          <span className="landing-demo-badge">{held ? "Paused" : "Illustration"}</span>
        </div>
        <div className="fd-viewport" aria-hidden="true">
          <div className={rootClass}>
            <aside className="fd-side">
              <span className="fd-wordmark"><span className="landing-mark"><i /><i /><i /></span>faceful</span>
              <span className="fd-search"><Search />Search studio<kbd>⌘K</kbd></span>
              <span className={`fd-nav ${docked ? "" : "is-active"}`}><Plus />Create</span>
              <span className={`fd-nav ${docked ? "is-active" : ""}`}><Layers />Campaigns<b>{step >= 3 && live ? 3 : 2}</b></span>
              <span className="fd-nav"><CalendarDays />Schedule</span>
              <span className="fd-label">Projects</span>
              <span className={`fd-project fd-project-new ${at(3)}`}><Folder />BeWell launch<b>{step >= 11 ? 4 : 3}</b></span>
              <span className="fd-project"><Folder />Autumn menu<b>2</b></span>
              <span className="fd-project"><Folder />Founder notes<b>1</b></span>
              <span className={`fd-agent ${step >= 10 && live ? "is-busy" : ""}`}><span className="fd-agent-icon"><Plug /></span><span><strong>1 agent connected</strong><small>Codex · via MCP</small></span></span>
            </aside>

            <div className="fd-main">
              <div className="fd-home">
                <span className="fd-home-symbol"><Sparkles /></span>
                <strong>What will we create today?</strong>
                <span>Describe your idea. Shape it with Faceful.</span>
              </div>
              <div className="fd-chips"><span>Choose a template</span><span>Plan a campaign</span><span>Find existing content</span></div>

              <div className="fd-canvas">
                <div className="fd-topbar"><span>Projects</span><ChevronRight /><strong>BeWell launch</strong><span className="fd-view"><Grid2X2 />Canvas</span></div>
                <div className="fd-heading"><strong>BeWell launch</strong><span>Draft campaign · Europe/Athens</span></div>
                <div className="fd-track">
                  <span className={`fd-pill ${at(4)} ${step >= 5 ? "is-ready" : ""}`}>
                    <span className="fd-pill-working"><i /><i /><i />Faceful is drafting</span>
                    <span className="fd-pill-ready"><Check />3 drafts ready</span>
                  </span>
                  {drafts.map((draft, index) => (
                    <div key={draft.title} className={`fd-card fd-card-${draft.tone} ${at(4)} ${index === 0 && step >= 6 && live ? "is-selected" : ""}`} style={{ transitionDelay: step === 4 ? `${index * 90}ms` : undefined }}>
                      <div className="fd-poster">
                        <span className="fd-poster-brand">{draft.brand}<small>9:16</small></span>
                        <span className="fd-poster-words">{draft.words.map((word) => <span key={word}>{word}</span>)}</span>
                        <span className="fd-poster-foot">Storyboard</span>
                      </div>
                      <div className="fd-card-meta">
                        <strong>{draft.title}</strong>
                        <span className="fd-state"><i />Draft{index === 0 ? <span className={`fd-version ${step >= 8 && live ? "is-v2" : ""}`}><span>v1</span><span>v2<Check /></span></span> : <span className="fd-version"><span>v1</span></span>}</span>
                      </div>
                      {index === 0 && <span className={`fd-slot ${at(9)}`}><i />Mon 09:00<small>needs your approval</small></span>}
                    </div>
                  ))}
                  <div className={`fd-card fd-card-d fd-card-agent ${at(11)}`}>
                    <div className="fd-poster">
                      <span className="fd-poster-brand">BeWell<small>9:16</small></span>
                      <span className="fd-poster-words"><span>Πίσω από</span><span>τη σκηνή.</span></span>
                      <span className="fd-poster-foot">Storyboard</span>
                    </div>
                    <div className="fd-card-meta"><strong>Πίσω από τη σκηνή</strong><span className="fd-state"><i />Draft<span className="fd-version"><span>v1</span></span><em>via MCP</em></span></div>
                  </div>
                </div>
                <span className={`fd-cursor ${step >= 10 && live ? "is-on" : ""} ${step >= 11 ? "is-clicked" : ""}`}><MousePointer2 /><span>Codex</span></span>
                <div className="fd-footer"><span><i />Live workspace</span><span>{step >= 11 ? 4 : step >= 4 ? 3 : 0} drafts · nothing rendered or scheduled</span></div>
              </div>
            </div>

            <aside className="fd-chat">
              <span className="fd-sheet-handle" />
              <div className="fd-chat-head"><span className="fd-chat-symbol"><Sparkles /></span><strong>AI Director</strong><span>BeWell launch</span></div>
              <div className="fd-thread">
                <p className={`fd-msg fd-user ${at(3)}`}>{PROMPT}</p>
                <div className="fd-reply">
                  <div className={`fd-msg fd-director fd-working ${step === 3 || step === 4 ? "is-in" : ""} ${latest === "working" ? "is-latest" : ""}`}><span className="fd-who"><Sparkles />AI Director</span><p>Drafting three angles<span className="fd-dots"><i /><i /><i /></span></p></div>
                  <div className={`fd-msg fd-director ${at(5)} ${latest === "saved" ? "is-latest" : ""}`}><span className="fd-who"><Sparkles />AI Director</span><p>Three drafts saved, in Greek. Nothing is rendered or scheduled yet.</p></div>
                </div>
                <p className={`fd-msg fd-user ${at(6)} ${latest === "ask" ? "is-latest" : ""}`}>Shorten the opening.</p>
                <div className={`fd-msg fd-proposal ${at(7)} ${step >= 8 && live ? "is-applied" : ""} ${latest === "proposal" ? "is-latest" : ""}`}>
                  <strong>Update draft · Καλώς ήρθες</strong>
                  <del>Γεια σου! Καλώς ήρθες στο φεστιβάλ BeWell.</del>
                  <ins>Γεια! Αυτό είναι το BeWell.</ins>
                  <span className="fd-proposal-foot"><span className="fd-apply">Apply changes</span><span className="fd-saved"><Check />Saved as version 2</span></span>
                </div>
                <div className={`fd-msg fd-director ${at(9)} ${latest === "schedule" ? "is-latest" : ""}`}><span className="fd-who"><Sparkles />AI Director</span><p>Proposed: Monday 09:00, Europe/Athens. Publishing needs your approval.</p></div>
              </div>
            </aside>

            <div className="fd-composer">
              <div className="fd-composer-field">
                <span className="fd-composer-typed">{PROMPT.slice(0, typed)}<i className="fd-caret" /></span>
                <span className="fd-composer-placeholder">What should we change?</span>
              </div>
              <div className="fd-composer-bar"><Paperclip /><span className="fd-composer-scope">Project · BeWell launch</span><span className="fd-send"><ArrowUp /></span></div>
            </div>
          </div>
        </div>
      </div>
      {motion && <button className="landing-demo-hold" aria-pressed={held} onClick={() => setHeld(!held)}>{held ? "Play demo animation" : "Pause demo animation"}</button>}
      <figcaption>Interface illustration with sample content. Nothing shown here was rendered, scheduled or published.</figcaption>
    </figure>
  );
}
