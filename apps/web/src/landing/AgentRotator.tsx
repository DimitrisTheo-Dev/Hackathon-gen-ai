import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Pause, Play } from "lucide-react";
import { AgentIcon, type AgentHost } from "../components/AgentIcon";

/**
 * Clients that speak MCP. Only the first two have been run against Faceful (Claude Code 2.1.325,
 * Codex CLI 0.169.0); the page says so wherever this list is shown.
 */
export const agents: ReadonlyArray<{ host: AgentHost; name: string; tested: boolean }> = [
  { host: "claude", name: "Claude Code", tested: true },
  { host: "codex", name: "Codex", tested: true },
  { host: "cursor", name: "Cursor", tested: false },
  { host: "gemini", name: "Gemini CLI", tested: false },
  { host: "vscode", name: "VS Code", tested: false },
  { host: "windsurf", name: "Windsurf", tested: false },
  { host: "zed", name: "Zed", tested: false },
];

const INTERVAL_MS = 2000;

/**
 * The accessible sentence never changes ("your agent"); only the decorative client name rotates.
 *
 * Nothing else may move when it does, so the chip has a line of its own and is centred on it: a
 * longer or shorter name grows or shrinks the chip evenly about its middle and has no neighbour to
 * push. The chip still hugs each name exactly. Its surface is drawn once at the widest name's width
 * and cut to the current name's measured width with clip-path, so the change is paint only: no
 * element is resized, and every transition retargets if it is interrupted.
 */
export function RotatingAgentHeadline() {
  const [{ current, leaving }, setTurn] = useState<{ current: number; leaving: number | null }>({ current: 0, leaving: null });
  const [paused, setPaused] = useState(false);
  const [motion, setMotion] = useState(false);
  const [restart, setRestart] = useState(0);
  /** Label widths in em of the headline size, so they stay true while the fluid type scales. */
  const [widths, setWidths] = useState<number[] | null>(null);
  /** Width changes ease only after the first measurement has been painted, so the chip never animates into place on load. */
  const [armed, setArmed] = useState(false);
  const chip = useRef<HTMLSpanElement>(null);
  const labels = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotion(!query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let alive = true;
    const measure = () => {
      const node = chip.current;
      if (!alive || !node) return;
      const em = parseFloat(getComputedStyle(node).fontSize);
      if (!em) return;
      const next = labels.current.map((label) => (label ? Math.ceil((label.getBoundingClientRect().width / em) * 1000) / 1000 : 0));
      if (next.some((width) => width === 0)) return;
      setWidths((previous) => (previous && previous.every((width, index) => Math.abs(width - next[index]) < 0.004) ? previous : next));
    };
    const observer = new ResizeObserver(measure);
    labels.current.forEach((label) => label && observer.observe(label));
    measure();
    // The web font can arrive after first paint; the chip then settles onto the new widths in place.
    void document.fonts?.ready.then(measure);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, []);

  const measured = widths !== null;
  useEffect(() => {
    if (!measured) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setArmed(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [measured]);

  useEffect(() => {
    if (!motion || paused) return;
    const timer = window.setInterval(() => {
      // A hidden tab should not burn through the list and resume on a random name.
      if (!document.hidden) setTurn((turn) => ({ current: (turn.current + 1) % agents.length, leaving: turn.current }));
    }, INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [motion, paused, restart]);

  /** Pressing the chip moves straight to the next client and gives it a full turn on screen. */
  function advance() {
    if (!motion) return;
    setTurn((turn) => ({ current: (turn.current + 1) % agents.length, leaving: turn.current }));
    setRestart((value) => value + 1);
  }

  const chipStyle = widths ? ({ "--agent-w": `${widths[current]}em`, "--agent-max": `${Math.max(...widths)}em` } as CSSProperties) : undefined;
  return (
    <div className="landing-rotating-headline">
      <h1 id="landing-title" className="hero-title landing-question-title" aria-label="What if your agent made your next video campaign?">
        <span className="landing-question" aria-hidden="true">
          <span className="landing-question-opening">What if</span>
          <span className="landing-question-agent">
            <span ref={chip} className={`landing-agent-chip ${widths ? "is-measured" : ""} ${armed ? "is-armed" : ""} ${motion ? "is-live" : ""}`} style={chipStyle} onClick={advance}>
              {/* An invisible in-flow copy of the current name gives the chip its natural size before
                  measurement and without JavaScript. */}
              <span className="landing-agent-sizer">
                <span className="landing-agent-logo" />
                {agents[current].name}
              </span>
              <span className="landing-agent-material">
                <span className="landing-agent-ring" />
                <span className="landing-agent-face">
                  {agents.map(({ host, name }, index) => (
                    <span
                      key={host}
                      ref={(node) => {
                        labels.current[index] = node;
                      }}
                      className={`landing-agent-name ${current === index ? "is-current" : ""} ${leaving === index ? "is-leaving" : ""}`}
                    >
                      <span className="landing-agent-logo">
                        <AgentIcon host={host} size={40} tile />
                      </span>
                      {name}
                    </span>
                  ))}
                </span>
              </span>
            </span>
          </span>
          <span className="landing-question-outcome">
            <span>made your next</span> <span>video campaign?</span>
          </span>
        </span>
      </h1>
      {motion && (
        <div className="landing-headline-controls">
          <button className="landing-motion-control" onClick={() => setPaused(!paused)} aria-pressed={paused} aria-label={paused ? "Resume agent rotation" : "Pause agent rotation"}>
            {paused ? <Play size={11} /> : <Pause size={11} />}
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The same clients as a plain, static list: what reduced-motion readers and crawlers see. */
export function AgentList({ className = "" }: { className?: string }) {
  return (
    <ul className={`landing-agent-list ${className}`} aria-label="MCP clients">
      {agents.map(({ host, name }) => (
        <li key={host}>
          <AgentIcon host={host} size={26} tile />
          {name}
        </li>
      ))}
    </ul>
  );
}
