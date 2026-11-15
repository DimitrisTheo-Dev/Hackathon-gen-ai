import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowUp, AudioLines, CalendarDays, Captions, Check, ChevronRight, Clapperboard, Copy, FileText, Folder, Grid2X2, Instagram, LayoutTemplate, MousePointer2, Music, Music2, Paperclip, Plug, Plus, Search, Sparkles, UserRound, Youtube } from "lucide-react";

/**
 * A coded illustration of the real studio: Projects on the left, the storyboard canvas in the
 * middle, the AI Director chat on the right. It tells one short story in a loop:
 * prompt → the composer docks into the chat → presenter drafts land → a presenter is chosen →
 * an edit becomes version 2 → a posting time waits for approval → a connected agent adds a draft →
 * the draft opens in the video editor (template, persona, brand kit, a multi-track timeline playing) →
 * the agent adds a closing card to the timeline over MCP → the three destinations wait for approval.
 *
 * It is an interface illustration with sample content. Nothing is rendered, scheduled or published,
 * and the markup never claims otherwise. Server-rendered HTML is the composed final frame, which is
 * also what reduced-motion visitors keep.
 */
const PROMPT = "Create a 15-second Reel for BeWell with a friendly Greek presenter, ready for Monday.";

const STEP = { home: 0, typing: 1, send: 2, dock: 3, drafts: 4, ready: 5, pick: 6, ask: 7, proposal: 8, applied: 9, schedule: 10, agentCursor: 11, agentCard: 12, video: 13, play: 14, agentEdit: 15, destinations: 16, fade: 17, rewind: 18 } as const;

/** [time in ms, step]. Steps only ever toggle classes; all motion is CSS transform/opacity. */
const TIMELINE: ReadonlyArray<readonly [number, number]> = [
  [0, STEP.home], // centred composer
  [400, STEP.typing],
  [1750, STEP.send], // send pressed
  [1950, STEP.dock], // composer docks right, chat and canvas open, message lands
  [2450, STEP.drafts], // drafts arrive, "Drafting…"
  [3250, STEP.ready], // "3 drafts ready", the presenter row appears
  [3900, STEP.pick], // another presenter is chosen; every draft takes them on
  [4800, STEP.ask], // follow-up request
  [5300, STEP.proposal], // reviewable change
  [6150, STEP.applied], // applied → version 2, the caption on the card changes with it
  [6900, STEP.schedule], // posting time proposed, needs approval
  [7700, STEP.agentCursor], // agent cursor glides in
  [8400, STEP.agentCard], // agent's draft lands
  [9500, STEP.video], // the first draft opens in the video editor
  [9900, STEP.play], // the timeline plays: playhead, karaoke captions, voice
  [11500, STEP.agentEdit], // the agent drops a closing card onto the timeline over MCP
  [12600, STEP.destinations], // Reels, TikTok and Shorts, waiting for approval
  [14300, STEP.fade],
  [14600, STEP.rewind], // rewind poses with transitions off
];
const LOOP_MS = 14750;
const TYPE_START = 400;
const TYPE_END = 1650;
const FINAL_STEP: number = STEP.agentCard;

/**
 * The cast: four original, featureless figures drawn here in SVG. They are not photographs, not
 * real people and not anyone else's characters; they stand in for the presenters a draft can use.
 */
export type PresenterId = "eleni" | "nikos" | "daphne" | "iris";
export const cast: Record<PresenterId, { name: string; skin: string; shade: string; hair: string; top: string; trim: string }> = {
  eleni: { name: "Eleni", skin: "#e9b893", shade: "#d7a07b", hair: "#4a2c20", top: "#f6efe2", trim: "#e4d8c2" },
  nikos: { name: "Nikos", skin: "#d8a47f", shade: "#c28c68", hair: "#2b2420", top: "#3e5a66", trim: "#32495380" },
  daphne: { name: "Daphne", skin: "#a9714e", shade: "#8f5c3e", hair: "#2a1a16", top: "#e3ae3f", trim: "#cc972c" },
  iris: { name: "Iris", skin: "#f2cfb6", shade: "#e2b89b", hair: "#b5633b", top: "#34332f", trim: "#fbf8f1" },
};
const castOrder: readonly PresenterId[] = ["eleni", "nikos", "daphne", "iris"];
const FIRST_PRESENTER: PresenterId = "eleni";
const PICKED_PRESENTER: PresenterId = "nikos";

const HEAD = "M61 135C61 112 74 103 90 103s29 9 29 32c0 27-13 46-29 46s-29-19-29-46Z";
const TORSO = "M-14 324C-12 262 20 226 56 216l16-5q18 15 36 0l16 5c36 10 68 46 70 108Z";
const NECK = "M75 164h30l1 42q-16 16-32 0Z";

function Figure({ who }: { who: PresenterId }) {
  const { skin, shade, hair, top, trim } = cast[who];
  const ears = <path fill={shade} d="M57 139c-5 0-6 14 1 16ZM123 139c5 0 6 14-1 16Z" />;
  return (
    <>
      {who === "eleni" && <path fill={hair} d="M50 150C44 108 64 90 90 90s46 18 40 60c0 36 10 62 6 90H44c-4-28 6-54 6-90Z" />}
      {who === "daphne" && (
        <g fill={hair}>
          <circle cx="90" cy="122" r="44" /><circle cx="54" cy="128" r="22" /><circle cx="126" cy="128" r="22" /><circle cx="62" cy="100" r="22" /><circle cx="118" cy="100" r="22" /><circle cx="90" cy="90" r="24" /><circle cx="50" cy="156" r="17" /><circle cx="130" cy="156" r="17" />
        </g>
      )}
      {who === "iris" && <g fill={hair}><circle cx="90" cy="88" r="17" /><path d="M57 150c-4-38 12-52 33-52s37 14 33 52Z" /></g>}
      <path fill={top} d={TORSO} />
      {who === "iris" && <path fill={trim} d="M73 210q17 15 34 0l-13 96h-8Z" />}
      <path fill={skin} d={NECK} />
      <path fill={shade} d="M75 172c8 12 22 12 30 0v14c-9 8-21 8-30 0Z" />
      {who === "daphne" && <path fill={trim} d="M71 196q19 14 38 0v18q-19 13-38 0Z" />}
      {who === "nikos" && <path fill="none" stroke={trim} strokeWidth="5" strokeLinecap="round" d="M72 212q18 15 36 0" />}
      {who === "eleni" && <path fill="none" stroke={trim} strokeWidth="4" strokeLinecap="round" d="M71 212q19 16 38 0" />}
      {(who === "nikos" || who === "iris") && ears}
      <path fill={skin} d={HEAD} />
      {who === "eleni" && <path fill={hair} d="M122 148C126 116 110 96 90 96S54 116 58 152C61 132 74 117 98 112c14 2 21 16 24 36Z" />}
      {who === "nikos" && (
        <g fill={hair}>
          <path d="M58 134c-4-28 14-40 34-40 18 0 34 12 30 40-4-12-10-20-22-22-12-2-30 0-42 22Z" />
          <path d="M61 149c1 23 14 34 29 34s28-11 29-34c-5 11-14 16-29 16s-24-5-29-16Z" />
        </g>
      )}
      {who === "daphne" && (
        <>
          <g fill={hair}><circle cx="72" cy="110" r="13" /><circle cx="90" cy="106" r="14" /><circle cx="108" cy="110" r="13" /></g>
          <g fill="#f1c453"><circle cx="59" cy="166" r="3.4" /><circle cx="121" cy="166" r="3.4" /></g>
        </>
      )}
      {who === "iris" && <path fill={hair} d="M59 136c-1-24 15-35 33-35 18 0 31 11 29 35-9-14-21-20-37-18-10 2-20 8-25 18Z" />}
    </>
  );
}

/** A presenter framed like a portrait video: head and shoulders, cropped by the 9:16 card. */
export function Presenter({ who, className = "" }: { who: PresenterId; className?: string }) {
  return <svg className={`fd-figure ${className}`} viewBox="0 0 180 320" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false"><Figure who={who} /></svg>;
}

/** The same figure cropped to a face, for the row a presenter is chosen from. */
function PresenterFace({ who }: { who: PresenterId }) {
  return <svg viewBox="26 84 128 128" aria-hidden="true" focusable="false"><Figure who={who} /></svg>;
}

/**
 * A reel-style caption: the script line over the presenter, each word lighting up as it is "spoken".
 * A still illustration passes `spoken` to hold one word lit instead.
 */
export function Caption({ words, className = "", spoken }: { words: readonly string[]; className?: string; spoken?: number }) {
  return (
    <span className={`fd-caption-line ${className}`}>
      <span className="fd-caption-text">
        {words.map((word, index) => <Fragment key={`${index}-${word}`}>{index > 0 && " "}<i className={spoken === index ? "is-spoken" : undefined} data-w={word} style={{ "--i": index } as CSSProperties}>{word}</i></Fragment>)}
      </span>
    </span>
  );
}

const drafts = [
  { tone: "a", title: "Καλώς ήρθες", words: ["Γεια", "σου!", "Καλώς", "ήρθες", "στο", "φεστιβάλ", "BeWell."], revised: ["Γεια!", "Αυτό", "είναι", "το", "BeWell."] },
  { tone: "b", title: "Η μέρα σου", words: ["Η", "μέρα", "σου,", "όπως", "τη", "θες."], revised: null },
  { tone: "c", title: "Τα λέμε εκεί", words: ["Τα", "λέμε", "εκεί,", "τη", "Δευτέρα."], revised: null },
] as const;
const AGENT_DRAFT = { title: "Πίσω από τη σκηνή", words: ["Πάμε", "πίσω", "από", "τη", "σκηνή."] } as const;
/** The voice track's waveform: fixed heights, so server and client draw the same bars. */
const WAVE = [38, 62, 80, 54, 92, 70, 44, 76, 96, 60, 40, 72, 88, 52, 66, 90, 58, 36, 74, 84, 50, 68, 94, 46, 62, 80, 42, 70];

export function StudioDemo() {
  const [step, setStep] = useState<number>(FINAL_STEP);
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
      setTyped(next === STEP.home || next === STEP.rewind ? 0 : now >= TYPE_END ? PROMPT.length : Math.max(0, Math.round(((now - TYPE_START) / (TYPE_END - TYPE_START)) * PROMPT.length)));
    };
    tick();
    const timer = window.setInterval(tick, 40);
    return () => { window.clearInterval(timer); elapsed.current = (Date.now() - origin) % LOOP_MS; };
  }, [motion, playing]);

  const live = step < STEP.fade;
  const at = (from: number) => (live && step >= from ? "is-in" : "");
  const on = (from: number) => live && step >= from;
  const docked = step >= STEP.dock && step !== STEP.rewind;
  const picked = on(STEP.pick);
  const latest = step >= STEP.agentEdit ? "agentEdit" : step >= STEP.video ? "video" : step >= STEP.schedule ? "schedule" : step >= STEP.proposal ? "proposal" : step >= STEP.ask ? "ask" : step >= STEP.ready ? "saved" : step >= STEP.dock ? "working" : "";
  const rootClass = ["fd", docked ? "is-docked" : "is-home", step === STEP.send ? "is-sending" : "", picked ? "has-pick" : "", on(STEP.agentCard) ? "has-agent-card" : "", on(STEP.video) ? "is-video" : "", on(STEP.agentEdit) ? "has-edit-msg" : "", step === STEP.fade ? "is-fading" : "", step === STEP.rewind ? "is-rewinding" : ""].filter(Boolean).join(" ");
  /** The name chip on a draft: the presenter's name beside a small "speaking" meter. */
  const nameChip = (names: readonly PresenterId[]) => (
    <span className="fd-presenter">
      <span className="fd-meter"><i /><i /><i /></span>
      <span className="fd-swap">{names.map((id, index) => <span key={id} className={names.length > 1 ? (index === 0 ? "is-first" : "is-picked") : ""}>{cast[id].name}</span>)}</span>
    </span>
  );

  return (
    <figure
      ref={figure}
      className="landing-demo"
      aria-label="Animated illustration of the Faceful studio. A typed request becomes three presenter drafts with captions beside the AI Director chat. A presenter is chosen for them, an edit is saved as version 2, a posting time waits for approval, and a connected agent adds a draft. The first draft then opens in the video editor with its template, persona and brand kit and a timeline of picture, voice, music and captions; the agent adds a closing card over MCP, and Instagram Reels, TikTok and YouTube Shorts wait for approval."
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
              <span className="fd-nav"><LayoutTemplate />Templates<b>11</b></span>
              <span className="fd-nav"><Copy />Clone a video</span>
              <span className="fd-nav"><CalendarDays />Schedule</span>
              <span className="fd-nav"><UserRound />Personas</span>
              <span className="fd-nav"><FileText />Brand kit</span>
              <span className="fd-label">Projects</span>
              <span className={`fd-project fd-project-new ${at(STEP.dock)}`}><Folder />BeWell launch<b>{step >= STEP.agentCard ? 4 : 3}</b></span>
              <span className="fd-project"><Folder />Autumn menu<b>2</b></span>
              <span className="fd-project"><Folder />Founder notes<b>1</b></span>
              <span className={`fd-agent ${on(STEP.agentCursor) ? "is-busy" : ""}`}><span className="fd-agent-icon"><Plug /></span><span><strong>1 agent connected</strong><small>Codex · 21 tools via MCP</small></span></span>
            </aside>

            <div className="fd-main">
              <div className="fd-home">
                <span className="fd-home-symbol"><Sparkles /></span>
                <strong>What will we create today?</strong>
                <span>Describe your idea. Shape it with Faceful.</span>
              </div>
              <div className="fd-chips"><span>Start from a template</span><span>Clone a video</span><span>Plan a campaign</span></div>

              <div className="fd-canvas">
                <div className="fd-topbar"><span>Projects</span><ChevronRight /><strong>BeWell launch</strong><span className="fd-view"><span className="fd-view-option"><Grid2X2 />Canvas</span><span className="fd-view-option"><Clapperboard />Video</span></span></div>
                <div className="fd-heading"><strong>BeWell launch</strong><span>Draft campaign · Europe/Athens</span></div>
                <div className="fd-track">
                  <span className={`fd-pill ${at(STEP.drafts)} ${step >= STEP.ready ? "is-ready" : ""}`}>
                    <span className="fd-pill-working"><i /><i /><i />Faceful is drafting</span>
                    <span className="fd-pill-ready"><Check />3 drafts ready</span>
                  </span>
                  {/* The presenter row: one tap moves the ring, and every draft takes that presenter on. */}
                  <span className={`fd-cast ${at(STEP.ready)} ${picked ? "is-picked" : ""}`}>
                    <small>Presenter</small>
                    <span className="fd-cast-row">
                      <span className="fd-cast-ring" />
                      {castOrder.map((id) => <span key={id} className={`fd-face fd-face-${id} ${id === PICKED_PRESENTER ? "is-target" : ""}`}><PresenterFace who={id} /></span>)}
                    </span>
                  </span>
                  {drafts.map((draft, index) => (
                    <div key={draft.title} className={`fd-card fd-card-${draft.tone} ${at(STEP.drafts)} ${index === 0 && on(STEP.ask) ? "is-selected" : ""}`} style={{ transitionDelay: step === STEP.drafts ? `${index * 90}ms` : undefined, "--n": index } as CSSProperties}>
                      <div className="fd-poster">
                        <span className="fd-stage">
                          <Presenter who={FIRST_PRESENTER} className="is-first" />
                          <Presenter who={PICKED_PRESENTER} className="is-picked" />
                        </span>
                        <span className="fd-poster-top">{nameChip([FIRST_PRESENTER, PICKED_PRESENTER])}<small>Storyboard</small></span>
                        <span className={`fd-caption ${draft.revised && on(STEP.applied) ? "is-revised" : ""}`}>
                          <Caption words={draft.words} />
                          {draft.revised && <Caption words={draft.revised} className="is-next" />}
                        </span>
                      </div>
                      <div className="fd-card-meta">
                        <strong>{draft.title}</strong>
                        <span className="fd-state"><i />Draft{index === 0 ? <span className={`fd-version ${on(STEP.applied) ? "is-v2" : ""}`}><span>v1</span><span>v2<Check /></span></span> : <span className="fd-version"><span>v1</span></span>}</span>
                      </div>
                      {index === 0 && <span className={`fd-slot ${at(STEP.schedule)}`}><i />Mon 09:00<small>needs your approval</small></span>}
                    </div>
                  ))}
                  <div className={`fd-card fd-card-d fd-card-agent ${at(STEP.agentCard)}`} style={{ "--n": 3 } as CSSProperties}>
                    <div className="fd-poster">
                      <span className="fd-stage"><Presenter who={PICKED_PRESENTER} /></span>
                      <span className="fd-poster-top">{nameChip([PICKED_PRESENTER])}<small>Storyboard</small></span>
                      <span className="fd-caption"><Caption words={AGENT_DRAFT.words} /></span>
                    </div>
                    <div className="fd-card-meta"><strong>{AGENT_DRAFT.title}</strong><span className="fd-state"><i />Draft<span className="fd-version"><span>v1</span></span><em>via MCP</em></span></div>
                  </div>
                </div>
                <span className={`fd-cursor ${on(STEP.agentCursor) && !on(STEP.video) ? "is-on" : ""} ${step >= STEP.agentCard ? "is-clicked" : ""}`}><MousePointer2 /><span>Codex</span></span>
                {/* Act two: the first draft in the video editor. Same presenter, the revised caption, the brand kit and a template. */}
                <div className={["fd-video", at(STEP.video), on(STEP.play) ? "is-playing" : "", on(STEP.agentEdit) ? "has-edit" : "", on(STEP.destinations) ? "has-destinations" : ""].filter(Boolean).join(" ")}>
                  <div className="fd-video-preview">
                    <span className="fd-stage"><Presenter who={PICKED_PRESENTER} /></span>
                    <span className="fd-poster-top">{nameChip([PICKED_PRESENTER])}<small>9:16 · 15 s</small></span>
                    <span className="fd-video-card">Δευτέρα 09:00</span>
                    <span className="fd-karaoke">{(drafts[0].revised ?? drafts[0].words).map((word, index) => <Fragment key={word}><i style={{ "--w": index } as CSSProperties}>{word}</i>{" "}</Fragment>)}</span>
                    <span className="fd-progress"><i /></span>
                  </div>
                  <div className="fd-video-side">
                    <div className="fd-video-facts">
                      <span><small>Template</small><b><LayoutTemplate />Talking tip</b></span>
                      <span><small>Presenter</small><b><UserRound />Nikos · persona</b></span>
                      <span><small>Brand kit</small><b><i className="fd-swatch" />BeWell</b></span>
                    </div>
                    <div className="fd-timeline">
                      <span className="fd-ruler"><i>0:00</i><i>0:05</i><i>0:10</i><i>0:15</i></span>
                      <span className="fd-lane"><small>Picture</small><span className="fd-lane-body"><span className="fd-clip fd-clip-picture" style={{ "--from": 0, "--to": 64 } as CSSProperties}>Nikos</span><span className="fd-clip fd-clip-broll" style={{ "--from": 64.6, "--to": 100 } as CSSProperties}>Festival b-roll</span></span></span>
                      <span className="fd-lane"><small>Cards</small><span className="fd-lane-body"><span className="fd-clip fd-clip-card" style={{ "--from": 70, "--to": 100 } as CSSProperties}>Δευτέρα 09:00<em>MCP</em></span></span></span>
                      <span className="fd-lane"><small>Voice</small><span className="fd-lane-body"><span className="fd-clip fd-clip-voice" style={{ "--from": 2, "--to": 90 } as CSSProperties}>{WAVE.map((height, index) => <i key={index} style={{ "--h": height } as CSSProperties} />)}</span></span></span>
                      <span className="fd-lane"><small>Music</small><span className="fd-lane-body"><span className="fd-clip fd-clip-music" style={{ "--from": 0, "--to": 100 } as CSSProperties}>Calm · 92 BPM</span></span></span>
                      <span className="fd-lane"><small>Captions</small><span className="fd-lane-body">{(drafts[0].revised ?? drafts[0].words).map((word, index, all) => <span key={word} className="fd-clip fd-clip-word" style={{ "--from": 4 + (index * 84) / all.length, "--to": 4 + ((index + 1) * 84) / all.length - 1.2 } as CSSProperties}>{word}</span>)}</span></span>
                      <span className="fd-playhead-track"><span className="fd-playhead" /></span>
                    </div>
                    <div className="fd-files"><small>Draft files</small><span><FileText />script.md</span><span><AudioLines />voice-take-2</span><span><Captions />captions.vtt</span><span><Music />music</span></div>
                  </div>
                  <div className="fd-destinations">
                    <span className="fd-destination"><Instagram />Reels</span>
                    <span className="fd-destination"><Music2 />TikTok</span>
                    <span className="fd-destination"><Youtube />Shorts</span>
                    <span className="fd-destination-slot"><i />Mon 09:00<small>needs your approval</small></span>
                  </div>
                </div>
                <div className="fd-footer"><span><i />Live workspace</span><span>{on(STEP.video) ? `Video edit · ${drafts[0].title} · timeline v${on(STEP.agentEdit) ? 2 : 1}` : `${step >= STEP.agentCard ? 4 : step >= STEP.drafts ? 3 : 0} drafts`} · nothing rendered or scheduled</span></div>
              </div>
            </div>

            <aside className="fd-chat">
              <span className="fd-sheet-handle" />
              <div className="fd-chat-head"><span className="fd-chat-symbol"><Sparkles /></span><strong>AI Director</strong><span>BeWell launch</span></div>
              <div className="fd-thread">
                <p className={`fd-msg fd-user ${at(STEP.dock)}`}>{PROMPT}</p>
                <div className="fd-reply">
                  <div className={`fd-msg fd-director fd-working ${step === STEP.dock || step === STEP.drafts ? "is-in" : ""} ${latest === "working" ? "is-latest" : ""}`}><span className="fd-who"><Sparkles />AI Director</span><p>Drafting three angles<span className="fd-dots"><i /><i /><i /></span></p></div>
                  <div className={`fd-msg fd-director ${at(STEP.ready)} ${latest === "saved" ? "is-latest" : ""}`}><span className="fd-who"><Sparkles />AI Director</span><p>Three drafts saved, in Greek. Nothing is rendered or scheduled yet.</p></div>
                </div>
                <p className={`fd-msg fd-user ${at(STEP.ask)} ${latest === "ask" ? "is-latest" : ""}`}>Shorten the opening.</p>
                <div className={`fd-msg fd-proposal ${at(STEP.proposal)} ${on(STEP.applied) ? "is-applied" : ""} ${latest === "proposal" ? "is-latest" : ""}`}>
                  <strong>Update draft · Καλώς ήρθες</strong>
                  <del>Γεια σου! Καλώς ήρθες στο φεστιβάλ BeWell.</del>
                  <ins>Γεια! Αυτό είναι το BeWell.</ins>
                  <span className="fd-proposal-foot"><span className="fd-apply">Apply changes</span><span className="fd-saved"><Check />Saved as version 2</span></span>
                </div>
                <div className={`fd-msg fd-director ${at(STEP.schedule)} ${latest === "schedule" ? "is-latest" : ""}`}><span className="fd-who"><Sparkles />AI Director</span><p>Proposed: Monday 09:00, Europe/Athens. Publishing needs your approval.</p></div>
                <div className={`fd-msg fd-director ${at(STEP.video)} ${latest === "video" ? "is-latest" : ""}`}><span className="fd-who"><Sparkles />AI Director</span><p>Opened the video edit: the Talking tip template, Nikos and your brand colours, with voice, music and captions on the timeline.</p></div>
                <div className={`fd-msg fd-agent-msg ${at(STEP.agentEdit)} ${latest === "agentEdit" ? "is-latest" : ""}`}><span className="fd-who"><Plug />Codex · via MCP</span><p><code>save_video_timeline</code> added a closing card. Saved as timeline version 2.</p></div>
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
