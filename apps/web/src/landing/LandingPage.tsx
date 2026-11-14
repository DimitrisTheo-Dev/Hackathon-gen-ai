import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { AgentIcon } from "../components/AgentIcon";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  Circle,
  Clock3,
  FileText,
  Folder,
  Grid2X2,
  History,
  Layers,
  LockKeyhole,
  Menu,
  MessageSquareText,
  Minus,
  PanelRight,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  UserRound,
  Terminal,
  Video,
  X,
} from "lucide-react";

const sampleItems = [
  {
    title: "Find your next moment",
    words: ["A little more", "room to", "be well."],
    date: "Mon 16 Nov · 09:00",
    script: "A festival day, made for you. The BeWell app helped visitors explore activities and save sessions for their day.",
    angle: "Visitor experience",
  },
  {
    title: "One idea. Two platforms.",
    words: ["One idea.", "Two", "platforms."],
    date: "Wed 18 Nov · 09:00",
    script: "Quintessential built the BeWell app with React Native. One shared codebase brought the festival experience to both iOS and Android.",
    angle: "Cross-platform engineering",
  },
  {
    title: "A familiar feeling",
    words: ["Feels", "like", "BeWell."],
    date: "Fri 20 Nov · 09:00",
    script: "The BeWell app carried the festival identity into a digital experience. Familiar design helped connect the event with the app in visitors’ hands.",
    angle: "Brand continuity",
  },
] as const;

const steps = [
  { label: "Brief", heading: "Start with what matters.", text: "Bring the company brief, audience and source material. Keep the facts close to the work, and make missing context visible.", detail: "Company context", fields: [["Company", "BeWell · example campaign"], ["Audience", "Festival visitors"], ["Tone", "Warm, clear, grounded in the source"]] },
  { label: "Create", heading: "Three ideas. One shared canvas.", text: "Plan a distinct angle for each piece. The studio keeps each draft and version separate, so you can improve one without disturbing the others.", detail: "Campaign plan", fields: [["Monday", "Visitor experience"], ["Wednesday", "Cross-platform engineering"], ["Friday", "Brand continuity"]] },
  { label: "Review", heading: "Make the small change that matters.", text: "Select a piece to refine its script, presenter or channel copy. Save the revision. Rendering remains a separate, capability-checked operation.", detail: "Selected content", fields: [["Item", "Find your next moment"], ["Change", "Make the opening warmer"], ["Next", "Save the draft, then render when available"]] },
  { label: "Approve & schedule", heading: "Know exactly what goes out.", text: "Review the final asset, copy, account and time together. Publication requires server-verified authorization and a separate receipt for each destination.", detail: "Review checklist", fields: [["Video", "Final render required"], ["Accounts", "Connect when you are ready to schedule"], ["Authorization", "Review required · no posts submitted"]] },
] as const;

const demoSteps = [
  { label: "Brief", heading: "One brief. Three distinct stories.", note: "Start with the company, audience and permitted source material." },
  { label: "Avatar", heading: "Choose who tells the story.", note: "Your live workspace would show only presenters you are authorized to use." },
  { label: "Generate", heading: "Compose the video, not just the footage.", note: "Avatar footage, captions and brand treatment become one reviewed asset." },
  { label: "Review", heading: "Make the small change that matters.", note: "Keep the script, channel copy and final composition together for review." },
  { label: "Schedule", heading: "Authorize the exact plan.", note: "An owner reviews the final asset, copy, accounts and requested times before submission." },
  { label: "Receipt", heading: "Know what happened on each channel.", note: "Provider acceptance, publication and a recoverable failure are different outcomes." },
] as const;

function DemoPhase({ stage, item, selected, avatar, captionStyle, onAvatar, onCaption }: {
  stage: number; item: typeof sampleItems[number]; selected: number; avatar: string;
  captionStyle: "Restrained" | "Expressive"; onAvatar: (value: string) => void;
  onCaption: (value: "Restrained" | "Expressive") => void;
}) {
  if (stage === 1) return <div className="landing-demo-avatars"><div className="landing-demo-choice-grid">{["Presenter A", "Presenter B"].map((name, index) => <button key={name} aria-pressed={avatar === name} aria-label={`Choose example ${name}`} onClick={() => onAvatar(name)}><span className={`landing-demo-person landing-demo-person-${index}`}><UserRound size={64} strokeWidth={1} /><span>Example avatar</span></span><strong>{name}</strong><span>{index === 0 ? "Direct & clear" : "Warm & conversational"}</span><span className="landing-demo-choice-state">{avatar === name ? <><Check size={14} />Selected for this demo</> : "Select example"}</span></button>)}</div><p className="landing-demo-disclosure">Illustrative presenters. No person, voice or avatar permission is being granted.</p></div>;
  if (stage === 2) return <div className="landing-demo-compose"><div className="landing-demo-output"><Storyboard item={item} index={selected} small /><span>Composition storyboard</span></div><div className="landing-demo-layers"><div><UserRound size={17} /><span><strong>Avatar footage</strong><small>{avatar} · current spoken script</small></span></div><div><MessageSquareText size={17} /><span><strong>Captions</strong><small>{captionStyle} subtitle treatment</small></span></div><div><Layers size={17} /><span><strong>Brand & output</strong><small>BeWell palette · portrait 9:16</small></span></div><p>One selected revision. A real render would run independently of your browser.</p><span className="landing-demo-disclosure">Render request illustration · no job submitted</span></div></div>;
  if (stage === 3) return <div className="landing-demo-review"><div className="landing-demo-review-copy"><span className="landing-demo-eyebrow">Selected script · example</span><blockquote>{item.script}</blockquote><div className="landing-demo-caption-choices" role="group" aria-label="Example subtitle treatment">{(["Restrained", "Expressive"] as const).map((style) => <button key={style} aria-pressed={captionStyle === style} onClick={() => onCaption(style)}>{style}</button>)}</div><p>Caption choice stays with this demonstration. Changing the composition would require a new final render and approval.</p></div><div className="landing-demo-caption-preview"><Storyboard item={item} index={selected} small /><span className={`landing-demo-caption-sample ${captionStyle === "Expressive" ? "is-expressive" : ""}`}>{item.title}</span><span className="landing-demo-disclosure">Caption layout illustration</span></div></div>;
  if (stage === 4) return <div className="landing-demo-manifest"><div className="landing-demo-manifest-heading"><LockKeyhole size={19} /><span><strong>Owner authorization comes first</strong><small>Example manifest · {avatar} · {captionStyle.toLowerCase()} captions</small></span></div><div className="landing-demo-manifest-copy"><span>Exact copy</span><p>{item.title} — a story from the published BeWell case study.</p></div><div className="landing-demo-schedule-rows">{["Instagram Reels", "TikTok", "YouTube Shorts"].map((platform) => <div key={platform}><span><strong>{platform}</strong><small>Example company account</small></span><time>{item.date}<small>Europe/Athens · requested</small></time></div>)}</div><p className="landing-demo-disclosure">Illustration only. No accounts are connected or authorized here. A live server must verify approval before any provider submission.</p></div>;
  if (stage === 5) return <div className="landing-demo-receipts"><div className="landing-demo-receipt-header"><FileText size={18} /><span>Illustrated provider responses</span><span>Example</span></div>{[
    ["Instagram Reels", "Accepted", "The provider accepted the request. Delivery is still pending."],
    ["YouTube Shorts", "Published", "A delivered post would include the provider’s post ID and URL."],
    ["TikTok", "Needs attention", "An account reconnection would not undo the other destinations."],
  ].map(([platform, state, detail]) => <div className="landing-demo-receipt-row" key={platform}><span><strong>{platform}</strong><small>{detail}</small></span><span className="landing-demo-receipt-state">{state}<small>example state</small></span></div>)}<p className="landing-demo-disclosure">Receipt illustration, not provider evidence. No live receipt, post ID or published URL exists in this preview.</p></div>;
  return null;
}

function CastroomMark() {
  return <span className="landing-mark" aria-hidden="true"><i /><i /><i /></span>;
}

function Wordmark() {
  return <a className="landing-wordmark" href="/" aria-label="Faceful home"><CastroomMark /><span>faceful</span></a>;
}

function LandingNav() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const menu = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const desktop = matchMedia("(min-width: 681px)");
    const closeOnDesktop = () => { if (desktop.matches) menu.current?.close(); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      document.documentElement.style.overflow = previousOverflow;
      desktop.removeEventListener("change", closeOnDesktop);
    };
  }, [open]);
  function closeMenu() { menu.current?.close(); }
  function restoreFocus() {
    setOpen(false);
    if (trigger.current?.offsetParent !== null) trigger.current?.focus({ preventScroll: true });
  }
  return <header className="landing-header">
    <div className="landing-nav-inner">
      <Wordmark />
      <nav className="landing-nav-links" aria-label="Main navigation">
        <a href="#why-castroom">Why Faceful</a>
        <a href="#features">Features</a>
        <a href="#what-works">What works today</a>
      </nav>
      <div className="landing-nav-actions">
        <a className="landing-button landing-primary landing-nav-cta" href="/studio/">Open studio <ArrowUpRight size={15} /></a>
        <button ref={trigger} className="landing-menu-toggle" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={open} aria-controls={menuId} onClick={() => { menu.current?.showModal(); setOpen(true); }}><Menu size={19} /></button>
      </div>
    </div>
    <dialog ref={menu} id={menuId} className="landing-mobile-menu" aria-labelledby={`${menuId}-title`} onClose={restoreFocus} onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeMenu();
    }}>
      <div className="landing-mobile-menu-heading"><span id={`${menuId}-title`}>Explore Faceful</span><button className="landing-menu-toggle" aria-label="Close navigation" onClick={closeMenu}><X size={19} /></button></div>
      <nav aria-label="Mobile navigation"><a href="#why-castroom" onClick={closeMenu}>Why Faceful <ArrowRight size={16} /></a><a href="#features" onClick={closeMenu}>Features <ArrowRight size={16} /></a><a href="#what-works" onClick={closeMenu}>What works today <ArrowRight size={16} /></a></nav>
      <a className="landing-button landing-primary" href="/studio/" onClick={closeMenu}>Open studio <ArrowUpRight size={16} /></a>
    </dialog>
  </header>;
}

/** The spoken/accessible sentence stays stable while the decorative client name rotates. */
export function RotatingAgentHeadline() {
  const [selected, setSelected] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [widths, setWidths] = useState<number[] | null>(null);
  const measures = useRef<(HTMLSpanElement | null)[]>([]);
  const agents = [{ host: "claude", name: "Claude Code" }, { host: "codex", name: "Codex" }] as const;
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    let mounted = true;
    const measure = () => {
      if (!mounted) return;
      const next = measures.current.map((node) => Math.ceil(node?.getBoundingClientRect().width ?? 160));
      setWidths((current) => current?.every((width, index) => width === next[index]) ? current : next);
    };
    const observer = new ResizeObserver(measure);
    measures.current.forEach((node) => { if (node) observer.observe(node); });
    measure();
    void document.fonts.ready.then(measure);
    return () => { mounted = false; observer.disconnect(); };
  }, []);
  useEffect(() => {
    if (paused || reduced) return;
    const timer = setInterval(() => setSelected((value) => (value + 1) % agents.length), 4200);
    return () => clearInterval(timer);
  }, [paused, reduced]);
  return <div className="landing-rotating-headline">
    <h1 id="landing-title" className="hero-title landing-question-title" aria-label="What if your agent made your next video campaign?">
      <span aria-hidden="true"><span className="landing-question-opening">What if <span className="landing-agent-slot" style={widths ? { "--agent-width": `${Math.max(...widths)}px`, "--active-agent-width": `${widths[selected]}px` } as CSSProperties : undefined}>
        <span className="landing-agent-slot-surface" />
        {agents.map(({ host, name }, index) => <span key={host} ref={(node) => { measures.current[index] = node; }} className={`landing-agent-name ${selected === index ? "is-current" : ""}`}><span className="landing-agent-logo"><AgentIcon host={host} size={32} /></span>{name}</span>)}
      </span></span><span className="landing-question-outcome">made your next video campaign?</span></span>
    </h1>
    <div className="landing-headline-controls">{!reduced && <button className="landing-motion-control" onClick={() => setPaused(!paused)} aria-pressed={paused} aria-label={paused ? "Resume agent rotation" : "Pause agent rotation"}>{paused ? <Play size={12} /> : <Pause size={12} />}{paused ? "Resume" : "Pause"}</button>}</div>
  </div>;
}

export function AgentHero({ variant = "primary" }: { variant?: "primary" | "companion" }) {
  if (variant === "companion") return <section className="landing-companion" aria-label="Bring your agent">
    <h2 className="landing-companion-title">Your next campaign starts here.</h2>
    <p>Bring your company brief. Shape the first draft.<br className="landing-desktop-break" /> Keep every decision close to the work.</p>
    <div className="landing-cta-row"><a className="landing-button landing-primary" href="/studio/">Start in the studio <ArrowRight size={16} /></a><a className="landing-button landing-secondary" href="/docs/setup/">Explore agent setup <ArrowUpRight size={16} /></a></div>
    <small>Codex and Claude Code setup templates are available. Live authentication is pending.</small>
  </section>;
  return <section className="landing-hero" aria-labelledby="landing-title">
    <div className="hero-title-container"><RotatingAgentHeadline /></div>
    <p className="landing-hero-description">One company brief. Three distinct stories.<br className="landing-desktop-break" /> Plan campaigns with your agent, refine each video in the studio, and <mark>keep the final say.</mark></p>
    <div className="landing-cta-row"><a className="landing-button landing-primary" href="/studio/">Open your studio <ArrowUpRight size={16} /></a><a className="landing-button landing-secondary" href="#workflow">See how it works <ArrowDown size={16} /></a></div>
    <p className="landing-hero-status">A working studio preview. Live generation and publishing are still being connected.</p>
  </section>;
}

function Storyboard({ item, index, small = false }: { item: typeof sampleItems[number]; index: number; small?: boolean }) {
  return <div className={`landing-storyboard landing-storyboard-${index} ${small ? "is-small" : ""}`}>
    <div className="landing-storyboard-brand">BeWell<span>STORIES</span></div>
    <div className="landing-storyboard-rule" aria-hidden="true" />
    <div className="landing-storyboard-words">{item.words.map((word) => <span key={word}>{word}</span>)}</div>
    <div className="landing-storyboard-bottom"><span>{String(index + 1).padStart(2, "0")}</span><span>Sample storyboard</span><ArrowUpRight size={small ? 10 : 15} /></div>
  </div>;
}

export function HeroPreviewWindow() {
  const [selected, setSelected] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [stage, setStage] = useState(0);
  const [avatar, setAvatar] = useState("Presenter A");
  const [captionStyle, setCaptionStyle] = useState<"Restrained" | "Expressive">("Restrained");
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [animateStage, setAnimateStage] = useState(false);
  const editorId = useId();
  const walkthroughId = useId();
  const stageButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const figure = useRef<HTMLElement>(null);
  const item = sampleItems[selected];
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { setReducedMotion(query.matches); if (query.matches) setPlaying(false); };
    update(); query.addEventListener("change", update);
    const pauseWhenHidden = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    const observer = new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) setPlaying(false); });
    if (figure.current) observer.observe(figure.current);
    return () => { query.removeEventListener("change", update); document.removeEventListener("visibilitychange", pauseWhenHidden); observer.disconnect(); };
  }, []);
  useEffect(() => {
    if (!playing || reducedMotion) return;
    if (stage === demoSteps.length - 1) { setPlaying(false); return; }
    const timer = setTimeout(() => { setAnimateStage(true); setStage(stage + 1); }, 5000);
    return () => clearTimeout(timer);
  }, [playing, reducedMotion, stage]);
  function selectStage(index: number, keyboard = false) { setPlaying(false); setAnimateStage(!keyboard); setStage(index); }
  function navigateStage(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % demoSteps.length : event.key === "ArrowLeft" ? (index + demoSteps.length - 1) % demoSteps.length : event.key === "Home" ? 0 : event.key === "End" ? demoSteps.length - 1 : null;
    if (next !== null) { event.preventDefault(); selectStage(next, true); stageButtons.current[next]?.focus(); }
  }
  function stopOnInteraction(target: EventTarget | null) { if (!(target instanceof Element) || !target.closest("[data-demo-play]")) setPlaying(false); }
  return <figure ref={figure} className="landing-demo" aria-labelledby="landing-demo-caption" onPointerDownCapture={(event) => stopOnInteraction(event.target)} onKeyDownCapture={(event) => stopOnInteraction(event.target)} onWheelCapture={() => setPlaying(false)}>
    <div className="landing-demo-frame">
      <div className="landing-demo-titlebar"><span className="landing-window-controls" aria-hidden="true"><i /><i /><i /></span><span>Faceful · Campaign studio</span><span className="landing-demo-badge">Interactive demo</span></div>
      <div className="landing-demo-walkthrough"><div className="landing-demo-walkthrough-heading"><span>From brief to publishing receipt</span><button data-demo-play className="landing-demo-play" disabled={reducedMotion} aria-pressed={playing} onClick={() => { if (stage === demoSteps.length - 1) setStage(0); setPlaying(!playing); }} aria-label={playing ? "Pause production walkthrough" : "Play production walkthrough"}>{playing ? <Pause size={13} /> : <Play size={13} />}{reducedMotion ? "Use the steps below" : playing ? "Pause demo" : "Play demo"}</button></div><div className="landing-demo-steps" role="tablist" aria-label="Production walkthrough">{demoSteps.map((step, index) => <button key={step.label} ref={(node) => { stageButtons.current[index] = node; }} id={`${walkthroughId}-step-${index}`} role="tab" aria-label={`${step.label}: demo step ${index + 1} of 6`} aria-selected={stage === index} aria-controls={`${walkthroughId}-panel`} tabIndex={stage === index ? 0 : -1} onClick={(event) => selectStage(index, event.detail === 0)} onKeyDown={(event) => navigateStage(event, index)}><span>{index + 1}</span>{step.label}</button>)}</div></div>
      <div className="landing-preview-shell">
        <aside className="landing-preview-nav" aria-label="Example workspace">
          <span className="landing-preview-wordmark"><CastroomMark />faceful</span>
          <div className="landing-preview-search"><Search size={14} /><span>Search content</span><kbd>⌘K</kbd></div>
          <div className="landing-preview-nav-row"><Layers size={16} />Campaigns<span>1</span></div>
          <div className="landing-preview-nav-row"><Clock3 size={16} />Schedule</div>
          <div className="landing-preview-nav-row"><BookOpen size={16} />Brand & sources</div>
          <div className="landing-preview-project-label">Projects</div>
          <div className="landing-preview-project"><Folder size={15} />A week of BeWell<span>3</span></div>
          <div className="landing-preview-nav-bottom"><Terminal size={15} /><span>Agent setup pending</span></div>
        </aside>
        <div className="landing-preview-canvas">
          <div className="landing-preview-breadcrumb"><span>Projects</span><span>/</span><strong>A week of BeWell</strong><PanelRight size={15} /></div>
          <div className="landing-preview-heading"><div><h2>A week of BeWell</h2><p>Three stories. One thoughtful campaign.</p></div><span className="landing-preview-view"><Grid2X2 size={14} />Canvas</span></div>
          <div className="landing-preview-board">
            <div className="landing-preview-board-label"><span>Example workflow · step {stage + 1} of 6</span><span>9:16</span></div>
            <div id={`${walkthroughId}-panel`} role="tabpanel" aria-labelledby={`${walkthroughId}-step-${stage}`} tabIndex={0} className="landing-demo-stage-panel">
              <div className={`landing-demo-stage-content ${animateStage ? "is-entering" : ""}`} key={stage}>
                <div className="landing-demo-stage-heading"><h3>{demoSteps[stage].heading}</h3><p>{demoSteps[stage].note}</p></div>
                {stage === 0 ? <><div className="landing-demo-brief"><FileText size={16} /><p>“Create three short videos from the BeWell case study: visitor experience, engineering and design.”</p><span>Example brief</span></div><div className="landing-preview-cards">
              {sampleItems.map((entry, index) => <button key={entry.title} className={`landing-preview-card ${selected === index ? "is-selected" : ""}`} onClick={() => setSelected(index)} aria-pressed={selected === index} aria-label={`Preview ${entry.title}`}>
                <Storyboard item={entry} index={index} />
                <div className="landing-preview-card-info"><strong>{entry.title}</strong><span><Circle size={7} />Draft<span>v1</span></span></div>
              </button>)}
                </div></> : <DemoPhase stage={stage} item={item} selected={selected} avatar={avatar} captionStyle={captionStyle} onAvatar={(value) => { setPlaying(false); setAvatar(value); }} onCaption={(value) => { setPlaying(false); setCaptionStyle(value); }} />}
              </div>
            </div>
            <div className="landing-demo-step-navigation"><span aria-live={playing ? "off" : "polite"}>{demoSteps[stage].label} · illustration</span><button onClick={(event) => selectStage(stage === demoSteps.length - 1 ? 0 : stage + 1, event.detail === 0)}>{stage === demoSteps.length - 1 ? "Back to brief" : `Next: ${demoSteps[stage + 1].label}`}<ArrowRight size={14} /></button></div>
            <div className="landing-preview-mobile-selector" aria-label="Example content">{sampleItems.map((entry, index) => <button key={entry.title} onClick={() => setSelected(index)} aria-pressed={selected === index} aria-label={`Show sample ${index + 1}: ${entry.title}`}>{index + 1}</button>)}</div>
            <button className="landing-preview-inspect" aria-controls={editorId} aria-expanded={editorOpen} onClick={() => setEditorOpen(!editorOpen)}><Settings2 size={16} />{editorOpen ? "Close draft details" : "Inspect this draft"}{editorOpen ? <Minus size={16} /> : <Plus size={16} />}</button>
            <div className="landing-preview-source"><FileText size={13} /><a href="https://www.quintessential.gr/work/bewell-festival" target="_blank" rel="noreferrer">Source: Quintessential’s published BeWell case study</a></div>
          </div>
          <div className="landing-preview-canvas-footer"><span><Circle size={7} />Sample drafts only</span><span>No jobs running</span></div>
        </div>
        <aside id={editorId} className={`landing-preview-editor ${editorOpen ? "is-mobile-open" : ""}`} aria-label="Selected example content">
          <div className="landing-preview-editor-title"><Settings2 size={15} /><span>Content details</span><span>v1</span></div>
          <div className="landing-preview-editor-body">
            <div className="landing-preview-mini"><Storyboard item={item} index={selected} small /></div>
            <div className="landing-preview-editor-heading"><span>Selected draft</span><h3>{item.title}</h3></div>
            <p className="landing-demo-editor-context">{avatar} · {captionStyle.toLowerCase()} captions<br />Demo choices only</p>
            <div className="landing-preview-editor-tabs"><span>Script</span><span>Avatar</span><span>Channels</span></div>
            <label className="landing-preview-script-label" htmlFor="sample-script">What your presenter says</label>
            <textarea id="sample-script" className="landing-preview-script" value={item.script} readOnly rows={5} aria-describedby="sample-script-help" />
            <p id="sample-script-help" className="landing-preview-help">Read-only example. Open the studio to edit.</p>
          </div>
          <a className="landing-preview-editor-cta" href="/studio/">Make it yours <ArrowUpRight size={14} /></a>
        </aside>
      </div>
    </div>
    <figcaption id="landing-demo-caption"><span>Explore the six steps, or play the illustrative walkthrough.</span> Representative storyboards, avatar choices and receipt examples—not generated videos or live provider results. Nothing is submitted or published.</figcaption>
  </figure>;
}

function Workflow() {
  const [selected, setSelected] = useState(0);
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % steps.length;
    if (event.key === "ArrowLeft") next = (index + steps.length - 1) % steps.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = steps.length - 1;
    if (next !== null) { event.preventDefault(); setSelected(next); refs.current[next]?.focus(); }
  }
  const step = steps[selected];
  return <section id="workflow" className="landing-workflow landing-section" aria-labelledby="workflow-heading">
    <div className="landing-section-heading"><h2 id="workflow-heading">One brief.<br />A place for every next step.</h2><p>Your agent handles the plan. The studio keeps the content, context and decisions together.</p></div>
    <div className="landing-workflow-tabs" role="tablist" aria-label="Campaign workflow">
      {steps.map((entry, index) => <button ref={(node) => { refs.current[index] = node; }} key={entry.label} id={`${id}-tab-${index}`} role="tab" aria-selected={selected === index} aria-controls={`${id}-panel`} tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} onKeyDown={(event) => onKeyDown(event, index)}>{entry.label}</button>)}
    </div>
    <div id={`${id}-panel`} className="landing-workflow-panel" role="tabpanel" aria-labelledby={`${id}-tab-${selected}`} tabIndex={0}>
      <div className="landing-workflow-copy"><span className="landing-step-label">{step.label}</span><h3>{step.heading}</h3><p>{step.text}</p><a href={selected === 3 ? "/docs/security/" : "/docs/capabilities/"}>Read how it works <ArrowRight size={15} /></a></div>
      <div className="landing-workflow-example"><div className="landing-example-title"><FileText size={16} /><strong>{step.detail}</strong><span>Example</span></div><dl>{step.fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p><Circle size={8} />Workflow illustration · live engine integration pending</p></div>
    </div>
  </section>;
}

function Features() {
  return <section id="features" className="landing-section landing-features" aria-labelledby="features-heading">
    <div className="landing-section-heading"><h2 id="features-heading">The details belong<br />with the work.</h2><p>A focused editor for people. A shared contract for agents. The same campaign, from either side.</p></div>
    <div className="landing-feature-grid">
      <article className="landing-feature landing-feature-wide"><div className="landing-feature-copy"><MessageSquareText size={22} /><h3>Small edits.<br />A clear point of view.</h3><p>Change the selected script, keep the draft while you move between pieces, and undo a local edit. Save only when it reads like you.</p></div><div className="landing-edit-backplate"><div className="landing-edit-example"><div><span>Opening line</span><span>Local draft</span></div><p className="landing-edit-before">Explore everything the festival has to offer.</p><p className="landing-edit-after">A festival day,<br />made for you.</p><footer><History size={14} /><span>Undo stays close at hand.</span></footer></div></div></article>
      <article className="landing-feature"><div className="landing-feature-copy"><Folder size={22} /><h3>A home for the<br />whole campaign.</h3><p>Keep source material, scripts, channel copy and requested times in one place. Every piece has its own revision.</p></div><div className="landing-folder-example"><span><Folder size={16} />A week of BeWell <span>3</span></span><div><Video size={15} />Visitor experience<span>Draft</span></div><div><Video size={15} />Engineering<span>Draft</span></div><div><Video size={15} />Brand continuity<span>Draft</span></div></div></article>
      <article className="landing-feature"><div className="landing-feature-copy"><LockKeyhole size={22} /><h3>Permission is<br />part of the product.</h3><p>An edit is not an approval. A queued request is not a published post. The interface keeps those decisions distinct.</p></div><div className="landing-approval-example"><div><LockKeyhole size={17} /><strong>Review required</strong></div><p>Final video · exact copy · named account · requested time</p><span>Publishing unavailable until the engine is connected</span></div></article>
    </div>
  </section>;
}

function CurrentStatus() {
  return <section id="what-works" className="landing-section landing-current-status" aria-labelledby="status-heading">
    <div><h2 id="status-heading">A working preview.<br />Clear about what’s ready.</h2><p>The studio is taking shape. Here’s the difference between the working interface and the live production journey.</p><a href="/docs/capabilities/">Full capability and limits guide <ArrowUpRight size={15} /></a></div>
    <div className="landing-status-list">
      <div><Check size={17} /><span><strong>Studio interface</strong><small>Manual drafts, focused editing, local undo and schedule review.</small></span><span className="landing-status-tag">Preview</span></div>
      <div><FileText size={17} /><span><strong>Agent setup documentation</strong><small>Codex and Claude Code templates, scopes and recovery guidance.</small></span><span className="landing-status-tag">Available</span></div>
      <div><Clock3 size={17} /><span><strong>Connected production</strong><small>Live MCP, Humanlike rendering and publishing receipts.</small></span><span className="landing-status-tag is-pending">Pending</span></div>
    </div>
  </section>;
}

const questions = [
  ["Do I need an agent to use the studio?", "No. You can start with a company brief and explicit scripts in the studio. The development preview saves those drafts in your browser. Connected, shared workspace execution is pending the backend integration."],
  ["What do Codex and Claude Code do?", "They are the first target clients for planning and producing campaigns through Faceful’s MCP interface. Setup templates are documented; authenticated connections and real client trials are not available yet."],
  ["Will content publish without my review?", "Review-first is the default design. Publication needs a server-verified approval for the exact final manifest, or a deliberate, bounded owner grant. The current preview cannot approve or publish anything."],
  ["Are these real generated videos?", "The landing preview contains original sample storyboards. It demonstrates selection and the editor layout. Humanlike video output, audio and final composition are not connected yet, so no generated-video result is claimed."],
] as const;

export function LandingPage() {
  return <div className="castroom-landing">
    <a className="landing-skip" href="#landing-title">Skip to content</a>
    <LandingNav />
    <main>
      <AgentHero />
      <div className="landing-wide"><HeroPreviewWindow /></div>
      <section id="why-castroom" className="landing-intro landing-section" aria-labelledby="why-heading">
        <div className="landing-integration-strip" aria-label="Planned integrations"><span><AgentIcon host="codex" size={22} />Codex</span><span><AgentIcon host="claude" size={22} />Claude Code</span><span><Layers size={18} />MCP</span><span><Video size={18} />Humanlike</span></div>
        <p className="landing-integration-note">Target clients and rendering integration. Live connections are pending.</p>
        <h2 id="why-heading">Your agent knows the brief.<br />Now give the work a home.</h2>
        <p>Content production needs more than a prompt. It needs brand context, permitted assets, revisions and a clear decision before anything goes out. Faceful brings that work into one shared studio.</p>
      </section>
      <Workflow />
      <Features />
      <CurrentStatus />
      <section className="landing-faq landing-section" aria-labelledby="faq-heading"><h2 id="faq-heading">A few useful answers.</h2><div>{questions.map(([question, answer]) => <details key={question}><summary>{question}<Plus className="landing-faq-plus" size={18} /><Minus className="landing-faq-minus" size={18} /></summary><p>{answer}</p></details>)}</div></section>
      <AgentHero variant="companion" />
    </main>
    <footer className="landing-footer"><div className="landing-footer-top"><Wordmark /><p>A shared place for content.<br />A clear place for decisions.</p><a href="/studio/">Open studio <ArrowUpRight size={15} /></a></div><div className="landing-footer-links"><nav aria-label="Product resources"><a href="/docs/">Documentation</a><a href="/docs/setup/">Agent setup</a><a href="/docs/api/">API</a><a href="/openapi.json">OpenAPI</a><a href="/llms.txt">For agents</a></nav><nav aria-label="About Faceful"><a href="/about/">About</a><a href="/contact/">Contact</a><a href="/privacy/">Privacy</a><a href="https://github.com/DimitrisTheo-Dev" target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={12} /></a></nav></div><div className="landing-footer-note"><span>Faceful · In development</span><span>Original studio. Inspired by thoughtful tools.</span></div></footer>
  </div>;
}
