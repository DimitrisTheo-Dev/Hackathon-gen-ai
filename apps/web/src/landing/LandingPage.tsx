import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
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

function CastroomMark() {
  return <span className="landing-mark" aria-hidden="true"><i /><i /><i /></span>;
}

function Wordmark() {
  return <a className="landing-wordmark" href="/" aria-label="Castroom home"><CastroomMark /><span>castroom</span></a>;
}

function LandingNav() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);
  return <header className="landing-header">
    <div className="landing-nav-inner">
      <Wordmark />
      <nav id={menuId} className={`landing-nav-links ${open ? "is-open" : ""}`} aria-label="Main navigation">
        <a href="#why-castroom" onClick={() => setOpen(false)}>Why Castroom</a>
        <a href="#features" onClick={() => setOpen(false)}>Features</a>
        <a href="#what-works" onClick={() => setOpen(false)}>What works today</a>
      </nav>
      <div className="landing-nav-actions">
        <a className="landing-button landing-primary landing-nav-cta" href="/studio/">Open studio <ArrowUpRight size={15} /></a>
        <button className="landing-menu-toggle" aria-label={open ? "Close navigation" : "Open navigation"} aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)}>{open ? <X size={19} /> : <Menu size={19} />}</button>
      </div>
    </div>
  </header>;
}

/** The spoken/accessible sentence stays stable while the decorative client name rotates. */
export function RotatingAgentHeadline() {
  const [selected, setSelected] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [widths, setWidths] = useState([168, 108]);
  const measures = useRef<(HTMLSpanElement | null)[]>([]);
  const names = ["Claude Code", "Codex"];
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const measure = () => setWidths(measures.current.map((node) => Math.ceil(node?.getBoundingClientRect().width ?? 160)));
    const observer = new ResizeObserver(measure);
    measures.current.forEach((node) => { if (node) observer.observe(node); });
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (paused || reduced) return;
    const timer = setInterval(() => setSelected((value) => (value + 1) % names.length), 4200);
    return () => clearInterval(timer);
  }, [paused, reduced]);
  return <>
    <h2 className="landing-companion-title" aria-label="What if your agent prepared your next campaign?">
      <span aria-hidden="true">What if <span className="landing-agent-slot" style={{ "--agent-width": `${Math.max(...widths)}px`, "--active-agent-width": `${widths[selected]}px` } as CSSProperties}>
        <span className="landing-agent-slot-surface" />
        {names.map((name, index) => <span key={name} ref={(node) => { measures.current[index] = node; }} className={`landing-agent-name ${selected === index ? "is-current" : ""}`}><Terminal size={25} strokeWidth={1.6} />{name}</span>)}
      </span><br />prepared your next campaign?</span>
    </h2>
    {!reduced && <button className="landing-motion-control" onClick={() => setPaused(!paused)} aria-pressed={paused}>{paused ? <Play size={12} /> : <Pause size={12} />}{paused ? "Resume names" : "Pause names"}</button>}
  </>;
}

export function AgentHero({ variant = "primary" }: { variant?: "primary" | "companion" }) {
  if (variant === "companion") return <section className="landing-companion" aria-label="Bring your agent">
    <RotatingAgentHeadline />
    <p>Castroom is being built for the agent you already use.<br className="landing-desktop-break" /> A shared place to turn a brief into content, with <mark>you in control.</mark></p>
    <div className="landing-cta-row"><a className="landing-button landing-primary" href="/docs/setup/">Connect your agent <ArrowUpRight size={16} /></a><a className="landing-button landing-secondary" href="/studio/">Start in the studio <ArrowRight size={16} /></a></div>
    <small>Codex and Claude Code setup templates are available. Live authentication is pending.</small>
  </section>;
  return <section className="landing-hero" aria-labelledby="landing-title">
    <div className="hero-title-container"><h1 id="landing-title" className="hero-title">Your agent runs<br />your content studio.</h1></div>
    <p className="landing-hero-description">From the company brief to the final detail.<br className="landing-desktop-break" /> Create campaigns with your agent. <mark>Fine-tune them here.</mark></p>
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
  const item = sampleItems[selected];
  return <figure className="landing-demo" aria-labelledby="landing-demo-caption">
    <div className="landing-demo-frame">
      <div className="landing-demo-titlebar"><span className="landing-window-controls" aria-hidden="true"><i /><i /><i /></span><span>Castroom · Campaign studio</span><span className="landing-demo-badge">Interactive demo</span></div>
      <div className="landing-preview-shell">
        <aside className="landing-preview-nav" aria-label="Example workspace">
          <span className="landing-preview-wordmark"><CastroomMark />castroom</span>
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
            <div className="landing-preview-board-label"><span>Company brief → campaign drafts</span><span>9:16</span></div>
            <div className="landing-preview-cards">
              {sampleItems.map((entry, index) => <button key={entry.title} className={`landing-preview-card ${selected === index ? "is-selected" : ""}`} onClick={() => setSelected(index)} aria-pressed={selected === index} aria-label={`Preview ${entry.title}`}>
                <Storyboard item={entry} index={index} />
                <div className="landing-preview-card-info"><strong>{entry.title}</strong><span><Circle size={7} />Draft<span>v1</span></span></div>
              </button>)}
            </div>
            <div className="landing-preview-mobile-selector" aria-label="Example content">{sampleItems.map((entry, index) => <button key={entry.title} onClick={() => setSelected(index)} aria-pressed={selected === index} aria-label={`Show sample ${index + 1}: ${entry.title}`}>{index + 1}</button>)}</div>
            <div className="landing-preview-source"><FileText size={13} /><a href="https://www.quintessential.gr/work/bewell-festival" target="_blank" rel="noreferrer">Source: Quintessential’s published BeWell case study</a></div>
          </div>
          <div className="landing-preview-canvas-footer"><span><Circle size={7} />Sample drafts only</span><span>No jobs running</span></div>
        </div>
        <aside className="landing-preview-editor" aria-label="Selected example content">
          <div className="landing-preview-editor-title"><Settings2 size={15} /><span>Content details</span><span>v1</span></div>
          <div className="landing-preview-editor-body">
            <div className="landing-preview-mini"><Storyboard item={item} index={selected} small /></div>
            <div className="landing-preview-editor-heading"><span>Selected draft</span><h3>{item.title}</h3></div>
            <div className="landing-preview-editor-tabs"><span>Script</span><span>Avatar</span><span>Channels</span></div>
            <label className="landing-preview-script-label" htmlFor="sample-script">What your presenter says</label>
            <textarea id="sample-script" className="landing-preview-script" value={item.script} readOnly rows={5} aria-describedby="sample-script-help" />
            <p id="sample-script-help" className="landing-preview-help">Read-only example. Open the studio to edit.</p>
          </div>
          <a className="landing-preview-editor-cta" href="/studio/">Make it yours <ArrowUpRight size={14} /></a>
        </aside>
      </div>
    </div>
    <figcaption id="landing-demo-caption"><span>Select a card to explore the editor.</span> Representative storyboards, not generated videos. Nothing is being published.</figcaption>
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
      <article className="landing-feature landing-feature-wide"><div className="landing-feature-copy"><MessageSquareText size={22} /><h3>Small edits.<br />A clear point of view.</h3><p>Change the selected script, keep the draft while you move between pieces, and undo a local edit. Save only when it reads like you.</p></div><div className="landing-edit-example"><div><span>Opening line</span><span>Local draft</span></div><p className="landing-edit-before">Explore everything the festival has to offer.</p><p className="landing-edit-after">A festival day,<br />made for you.</p><footer><History size={14} /><span>Undo stays close at hand.</span></footer></div></article>
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
  ["What do Codex and Claude Code do?", "They are the first target clients for planning and producing campaigns through Castroom’s MCP interface. Setup templates are documented; authenticated connections and real client trials are not available yet."],
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
        <div className="landing-integration-strip" aria-label="Planned integrations"><span><Terminal size={18} />Codex</span><span><Terminal size={18} />Claude Code</span><span><Layers size={18} />MCP</span><span><Video size={18} />Humanlike</span></div>
        <p className="landing-integration-note">Target clients and rendering integration. Live connections are pending.</p>
        <h2 id="why-heading">Your agent knows the brief.<br />Now give the work a home.</h2>
        <p>Content production needs more than a prompt. It needs brand context, permitted assets, revisions and a clear decision before anything goes out. Castroom brings that work into one shared studio.</p>
      </section>
      <Workflow />
      <Features />
      <CurrentStatus />
      <section className="landing-faq landing-section" aria-labelledby="faq-heading"><h2 id="faq-heading">A few useful answers.</h2><div>{questions.map(([question, answer]) => <details key={question}><summary>{question}<Plus className="landing-faq-plus" size={18} /><Minus className="landing-faq-minus" size={18} /></summary><p>{answer}</p></details>)}</div></section>
      <AgentHero variant="companion" />
    </main>
    <footer className="landing-footer"><div className="landing-footer-top"><Wordmark /><p>A shared place for content.<br />A clear place for decisions.</p><a href="/studio/">Open studio <ArrowUpRight size={15} /></a></div><div className="landing-footer-links"><nav aria-label="Product resources"><a href="/docs/">Documentation</a><a href="/docs/setup/">Agent setup</a><a href="/docs/api/">API</a><a href="/openapi.json">OpenAPI</a><a href="/llms.txt">For agents</a></nav><nav aria-label="About Castroom"><a href="/about/">About</a><a href="/contact/">Contact</a><a href="/privacy/">Privacy</a><a href="https://github.com/DimitrisTheo-Dev" target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={12} /></a></nav></div><div className="landing-footer-note"><span>Castroom · In development</span><span>Original studio. Inspired by thoughtful tools.</span></div></footer>
  </div>;
}
