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
const EXIT_MS = 260;

/**
 * The accessible sentence never changes ("your agent"); only the decorative client name rotates.
 * The slot hugs each name: its width animates to the measured width of the incoming label, so there
 * is never a gap beside a short name or a jump beside a long one.
 */
export function RotatingAgentHeadline() {
  const [{ current, leaving }, setTurn] = useState<{ current: number; leaving: number | null }>({ current: 0, leaving: null });
  const [paused, setPaused] = useState(false);
  const [motion, setMotion] = useState(false);
  const [widths, setWidths] = useState<number[] | null>(null);
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
      if (!alive) return;
      const next = labels.current.map((node) => (node ? Math.ceil(node.getBoundingClientRect().width * 4) / 4 : 0));
      if (next.some((width) => width === 0)) return;
      setWidths((previous) => (previous && previous.every((width, index) => Math.abs(width - next[index]) < 0.25) ? previous : next));
    };
    const observer = new ResizeObserver(measure);
    labels.current.forEach((node) => node && observer.observe(node));
    measure();
    void document.fonts?.ready.then(measure);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!motion || paused) return;
    const timer = window.setInterval(() => {
      // A hidden tab should not burn through the list and resume on a random name.
      if (!document.hidden) setTurn((turn) => ({ current: (turn.current + 1) % agents.length, leaving: turn.current }));
    }, INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [motion, paused]);

  useEffect(() => {
    if (leaving === null) return;
    // Once the outgoing name has faded, park it back below the line so it next enters from below again.
    const timer = window.setTimeout(() => setTurn((turn) => (turn.leaving === leaving ? { ...turn, leaving: null } : turn)), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const slotStyle = widths ? ({ width: `${widths[current]}px` } as CSSProperties) : undefined;
  return (
    <div className="landing-rotating-headline">
      <h1 id="landing-title" className="hero-title landing-question-title" aria-label="What if your agent made your next video campaign?">
        <span aria-hidden="true">
          <span className="landing-question-opening">
            What if{" "}
            <span className={`landing-agent-slot ${widths ? "is-measured" : ""}`} style={slotStyle}>
              {/* An invisible copy of the current name keeps the slot on the headline's baseline and gives it
                  its natural width before measurement (and without JavaScript). */}
              <span className="landing-agent-sizer"><span className="landing-agent-logo" />{agents[current].name}</span>
              <span className="landing-agent-clip">
                {agents.map(({ host, name }, index) => (
                  <span
                    key={host}
                    ref={(node) => {
                      labels.current[index] = node;
                    }}
                    className={`landing-agent-name ${current === index ? "is-current" : ""} ${leaving === index ? "is-leaving" : ""}`}
                  >
                    <span className="landing-agent-logo">
                      <AgentIcon host={host} size={32} />
                    </span>
                    {name}
                  </span>
                ))}
              </span>
            </span>
          </span>
          <span className="landing-question-outcome">made your next video campaign?</span>
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
          <span className="landing-agent-tile">
            <AgentIcon host={host} size={20} />
          </span>
          {name}
        </li>
      ))}
    </ul>
  );
}
