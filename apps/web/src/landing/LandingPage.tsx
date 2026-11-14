import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { ArrowRight, ArrowUpRight, Check, Copy, Menu, Minus, Plus, ShieldCheck, Sparkles, X } from "lucide-react";
import { AgentList, RotatingAgentHeadline } from "./AgentRotator";
import { StudioDemo } from "./StudioDemo";

export { RotatingAgentHeadline } from "./AgentRotator";

/** The exact command exercised with Codex CLI 0.169.0 (see /docs/mcp/). The token never appears in it. */
const MCP_COMMAND = "codex mcp add faceful --url https://faceful.vercel.app/mcp --bearer-token-env-var FACEFUL_TOKEN";
const TESTED_NOTE = "Tested with Claude Code and Codex. Any MCP client connects the same way.";

function FacefulMark() {
  return <span className="landing-mark" aria-hidden="true"><i /><i /><i /></span>;
}

function Wordmark() {
  return <a className="landing-wordmark" href="/" aria-label="Faceful home"><FacefulMark /><span>faceful</span></a>;
}

function LandingNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuId = useId();
  const menu = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const sentinel = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const desktop = matchMedia("(min-width: 761px)");
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
  return <>
    <span ref={sentinel} className="landing-scroll-sentinel" aria-hidden="true" />
    <header className={`landing-header ${scrolled ? "is-scrolled" : ""}`}>
      <div className="landing-nav-inner">
        <Wordmark />
        <nav className="landing-nav-links" aria-label="Main navigation">
          <a href="#how">How it works</a>
          <a href="#agents">For agents</a>
          <a href="/docs/">Docs</a>
        </nav>
        <div className="landing-nav-actions">
          <a className="landing-nav-login" href="/studio/">Log in</a>
          <a className="landing-button landing-primary landing-nav-cta" href="/studio/">Start creating</a>
          <button ref={trigger} className="landing-menu-toggle" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={open} aria-controls={menuId} onClick={() => { menu.current?.showModal(); setOpen(true); }}><Menu size={19} /></button>
        </div>
      </div>
      <dialog ref={menu} id={menuId} className="landing-mobile-menu" aria-labelledby={`${menuId}-title`} onClose={restoreFocus} onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeMenu();
      }}>
        <div className="landing-mobile-menu-heading"><span id={`${menuId}-title`}>Explore Faceful</span><button className="landing-menu-toggle" aria-label="Close navigation" onClick={closeMenu}><X size={19} /></button></div>
        <nav aria-label="Mobile navigation">
          <a href="#how" onClick={closeMenu}>How it works <ArrowRight size={16} /></a>
          <a href="#agents" onClick={closeMenu}>For agents <ArrowRight size={16} /></a>
          <a href="/docs/" onClick={closeMenu}>Docs <ArrowRight size={16} /></a>
          <a href="/studio/" onClick={closeMenu}>Log in <ArrowRight size={16} /></a>
        </nav>
        <a className="landing-button landing-primary" href="/studio/" onClick={closeMenu}>Start creating <ArrowUpRight size={16} /></a>
      </dialog>
    </header>
  </>;
}

function Hero() {
  return <section className="landing-hero" aria-labelledby="landing-title">
    <div className="hero-title-container"><RotatingAgentHeadline /></div>
    <p className="landing-hero-description">Describe the video you want. Faceful drafts it, you direct it by chatting, and your own AI agent can work in the same studio. <mark>Nothing posts without you.</mark></p>
    <div className="landing-cta-row">
      <a className="landing-button landing-primary" href="/studio/">Start creating <ArrowRight size={16} /></a>
      <a className="landing-button landing-secondary" href="#agents">Connect your agent</a>
    </div>
    <p className="landing-hero-status">{TESTED_NOTE}</p>
  </section>;
}

/** Reveals a block once, the first time it scrolls into view. Without JavaScript it is simply visible. */
function Reveal({ as: Tag = "div", className = "", children, ...rest }: { as?: "div" | "article" | "section" | "li"; className?: string; children: ReactNode; id?: string; "aria-labelledby"?: string }) {
  const node = useRef<HTMLElement>(null);
  const [state, setState] = useState<"static" | "pending" | "in">("static");
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    // Anything already on screen stays put, and reduced-motion readers never wait for content:
    // only blocks still below the fold get an entrance.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || element.getBoundingClientRect().top < innerHeight * 0.92) { setState("in"); return; }
    setState("pending");
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setState("in");
      observer.disconnect();
    }, { rootMargin: "0px 0px -12% 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const Element = Tag as "div";
  return <Element ref={node as Ref<HTMLDivElement>} className={`${className} ${state === "pending" ? "is-waiting" : state === "in" ? "is-in" : ""}`} {...rest}>{children}</Element>;
}

function HowItWorks() {
  return <section id="how" className="landing-section landing-how" aria-labelledby="how-heading">
    <div className="landing-section-heading">
      <h2 id="how-heading">From a sentence to a campaign you approve.</h2>
    </div>
    <div className="landing-bento">
      <Reveal as="article" className="landing-tile landing-tile-prompt">
        <div className="landing-tile-copy">
          <h3>One prompt. An editable draft.</h3>
          <p>Say what the video is for. You get scripts, captions and a posting time: saved as real drafts, not lost in a chat.</p>
        </div>
        <div className="lb-art lb-prompt-art" aria-hidden="true">
          <span className="lb-prompt"><Sparkles size={15} />A 15-second Reel for BeWell, friendly, in Greek.</span>
          <span className="lb-thread"><i /><i /><i /></span>
          <div className="lb-drafts">
            {[["Καλώς ήρθες", "a"], ["Η μέρα σου", "b"], ["Τα λέμε εκεί", "c"]].map(([title, tone]) => <span className="lb-draft" key={title}><span className={`lb-thumb lb-thumb-${tone}`} /><span><strong>{title}</strong><small>15 s · Greek · Draft v1</small></span></span>)}
          </div>
        </div>
      </Reveal>

      <Reveal as="article" className="landing-tile landing-tile-direct">
        <div className="landing-tile-copy">
          <h3>Direct it by chatting.</h3>
          <p>Ask for a change, see exactly what changes, apply it. Every edit is a new version, and the old one stays.</p>
        </div>
        <div className="lb-art lb-diff-art" aria-hidden="true">
          <span className="lb-bubble">Shorten the opening.</span>
          <div className="lb-diff">
            <small>Opening line</small>
            <del>Γεια σου! Καλώς ήρθες στο φεστιβάλ BeWell.</del>
            <ins>Γεια! Αυτό είναι το BeWell.</ins>
            <span className="lb-diff-foot"><span className="lb-apply">Apply changes</span><span className="lb-saved"><Check size={13} />Saved as v2</span></span>
          </div>
          <ol className="lb-versions"><li>v1</li><li className="is-current">v2</li><li className="is-next">v3</li></ol>
        </div>
      </Reveal>

      <Reveal as="article" className="landing-tile landing-tile-approve">
        <div className="landing-tile-copy">
          <h3>Nothing posts without you.</h3>
          <p>A schedule stays a proposal until a person approves that exact video, caption and time.</p>
        </div>
        <div className="lb-art lb-approve-art" aria-hidden="true">
          <div className="lb-approve">
            <span className="lb-approve-head"><ShieldCheck size={15} />Review schedule<span className="lb-tag lb-tag-wait"><span>Needs your approval</span><span><Check size={11} />Approved by you</span></span></span>
            <span className="lb-row"><small>Video</small><b>Καλώς ήρθες · v2</b></span>
            <span className="lb-row"><small>Caption</small><b>Γεια! Αυτό είναι το BeWell.</b></span>
            <span className="lb-row"><small>When</small><b>Mon 09:00 · Europe/Athens</b></span>
            <span className="lb-approve-button">Approve exact schedule</span>
          </div>
        </div>
        <small className="landing-tile-note">Publishing to social accounts is being connected.</small>
      </Reveal>

      <Reveal as="article" className="landing-tile landing-tile-credits">
        <div className="landing-tile-copy">
          <h3>Simple plans, shared credits.</h3>
          <p>One balance for the studio and your agents. A render holds a credit; a failed render gives it back.</p>
        </div>
        <div className="lb-art lb-credits-art" aria-hidden="true">
          <span className="lb-balance"><small>Render credits</small><b>2</b></span>
          <span className="lb-ledger">
            <span className="lb-row"><small>Starter credits</small><b>+3</b></span>
            <span className="lb-row"><small>Render from the studio</small><b>−1</b></span>
            <span className="lb-row"><small>Render from your agent</small><b>−1</b></span>
            <span className="lb-row"><small>Failed render returned</small><b>+1</b></span>
          </span>
        </div>
        <small className="landing-tile-note">Billing runs in Stripe test mode today.</small>
      </Reveal>

      <Reveal as="article" className="landing-tile landing-tile-status">
        <h3>Where things stand</h3>
        <dl>
          <div><dt><i className="is-live" />Live now</dt><dd>Drafts, chat direction, versions, agent access, approvals, test-mode billing</dd></div>
          <div><dt><i className="is-rolling" />Rolling out</dt><dd>Presenter video rendering with Humanlike</dd></div>
          <div><dt><i />Next</dt><dd>Publishing to your social accounts</dd></div>
        </dl>
      </Reveal>
    </div>
  </section>;
}

function CopyCommand() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(MCP_COMMAND);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be denied; the command stays selectable as text.
      setCopied(false);
    }
  }
  return <div className="landing-terminal">
    <div className="landing-terminal-bar"><span className="landing-window-controls" aria-hidden="true"><i /><i /><i /></span><span>Terminal</span>
      <button className="landing-copy" onClick={() => void copy()} aria-label="Copy the Codex setup command">{copied ? <Check size={14} /> : <Copy size={14} />}<span aria-live="polite">{copied ? "Copied" : "Copy"}</span></button>
    </div>
    <pre tabIndex={0} aria-label="Codex setup command"><code><span className="landing-terminal-prompt" aria-hidden="true">$ </span>{MCP_COMMAND}</code></pre>
    <p className="landing-terminal-hint">Then ask it: <q>List my Faceful projects.</q></p>
  </div>;
}

function Agents() {
  return <section id="agents" className="landing-agents" aria-labelledby="agents-heading">
    <Reveal className="landing-agents-inner">
      <div className="landing-agents-copy">
        <h2 id="agents-heading">Your agent works in the same studio.</h2>
        <p>Faceful is an MCP server. Projects, drafts and versions are the same whether you open the studio or ask your agent.</p>
        <ul className="landing-agents-facts">
          <li><b>13</b> tools, from drafting to schedule review</li>
          <li>Scoped tokens you can revoke at any time</li>
          <li>Agents can prepare a schedule. Only you can approve it.</li>
        </ul>
        <a className="landing-button landing-light" href="/docs/mcp/">Agent setup guide <ArrowUpRight size={16} /></a>
      </div>
      <div className="landing-agents-side">
        <CopyCommand />
        <AgentList />
        <p className="landing-agents-note">{TESTED_NOTE}</p>
      </div>
    </Reveal>
  </section>;
}

const questions = [
  ["Do I need an AI agent?", "No. Sign in and type what you want. Agents are optional, and they work on the same projects you see in the studio."],
  ["Are the videos real?", "Drafts, scripts, versions and schedules are real and saved to your workspace. Presenter video rendering with Humanlike is rolling out, so the demo above shows storyboards, not rendered video."],
  ["Can it post without my approval?", "No. A person approves the exact video, caption and time. Agents can prepare a schedule but cannot approve it. Publishing to social accounts is not connected yet."],
  ["What does it cost?", "Every workspace starts with a few render credits. Plans run in Stripe test mode today, so no real payment is taken."],
] as const;

export function LandingPage() {
  return <div className="castroom-landing">
    <a className="landing-skip" href="#landing-title">Skip to content</a>
    <LandingNav />
    <main>
      <Hero />
      <div className="landing-wide"><StudioDemo /></div>
      <HowItWorks />
      <Agents />
      <section className="landing-faq landing-section" aria-labelledby="faq-heading">
        <h2 id="faq-heading">Straight answers.</h2>
        <div>{questions.map(([question, answer]) => <details key={question}><summary>{question}<Plus className="landing-faq-plus" size={18} /><Minus className="landing-faq-minus" size={18} /></summary><p>{answer}</p></details>)}</div>
      </section>
      <section className="landing-companion" aria-labelledby="start-heading">
        <h2 id="start-heading" className="landing-companion-title">Your next video starts with a sentence.</h2>
        <p>Sign in with Google or an email code. No setup, no card.</p>
        <div className="landing-cta-row">
          <a className="landing-button landing-primary" href="/studio/">Start creating <ArrowRight size={16} /></a>
          <a className="landing-button landing-secondary" href="/docs/mcp/">Connect your agent <ArrowUpRight size={16} /></a>
        </div>
        <small>{TESTED_NOTE}</small>
      </section>
    </main>
    <footer className="landing-footer">
      <div className="landing-footer-top">
        <div><Wordmark /><p>Describe it. Direct it. Approve it.</p></div>
        <nav aria-label="Product"><strong>Product</strong><a href="/studio/">Studio</a><a href="/docs/">Documentation</a><a href="/docs/mcp/">Agent setup</a><a href="/docs/api/">API</a></nav>
        <nav aria-label="For agents"><strong>For agents</strong><a href="/llms.txt">llms.txt</a><a href="/openapi.json">OpenAPI</a><a href="/api/public/status">Live status</a></nav>
        <nav aria-label="About Faceful"><strong>Faceful</strong><a href="/about/">About</a><a href="/contact/">Contact</a><a href="/privacy/">Privacy</a><a href="https://github.com/DimitrisTheo-Dev" target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={12} /></a></nav>
      </div>
      <div className="landing-footer-note"><span>Faceful · In development</span><span>Presenter rendering by Humanlike, rolling out.</span></div>
    </footer>
  </div>;
}
