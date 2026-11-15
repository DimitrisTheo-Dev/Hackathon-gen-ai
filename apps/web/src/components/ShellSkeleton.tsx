import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";

/*
 * The studio's one loading visual.
 *
 * A refresh used to pass through five different screens (static HTML, the entry fallback, session restore,
 * the lazy studio chunk, the studio's own loading block). Now there is a single skeleton of the real shell:
 *   - `bootProbe` decides before first paint what the page is about to show and records it on <html>;
 *   - `ShellSkeleton` is the markup, styled only by /design.css so it is correct before any script runs.
 *     scripts/prerender.ts writes the same markup into the static studio page;
 *   - `BootLayer` keeps one instance mounted over the app while it starts, then cross-fades it away.
 * This module must stay dependency-free: the entry chunk and the prerender script both import it.
 */

/**
 * Runs before first paint. Self-contained on purpose: scripts/prerender.ts emits this function's source as the
 * blocking script of the static studio page, so it may not reference anything outside its own body.
 *   data-boot="shell"  a studio is about to open (a stored session, a sign-in return, or the local fixture)
 *   data-boot="auth"   nobody is signed in: the sign-in card comes next, never the skeleton
 *   data-boot="none"   another surface that shares this page (agent consent, connecting a social account, the Claude Code runner)
 */
export function bootProbe(): void {
  var root = document.documentElement;
  var path = location.pathname;
  var state = "none";
  root.removeAttribute("data-boot-view");
  root.removeAttribute("data-boot-sidebar");
  root.removeAttribute("data-boot-panel");
  try {
    var query = new URLSearchParams(location.search);
    if (/^\/dev\/studio(\/|$)/.test(path) && root.hasAttribute("data-fixtures")) state = "shell";
    // Connecting a social account (/studio/connect/<provider>) is its own page; the studio does not open under it.
    else if (/^\/studio\/connect\/[a-z0-9_]+\/?$/.test(path)) state = "none";
    else if (/^\/studio(\/|$)/.test(path)) {
      state = "auth";
      if (!query.has("error") && (/(^#|&)access_token=/.test(location.hash) || query.has("code"))) state = "shell";
      else
        for (var index = 0; index < localStorage.length; index++) {
          var key = localStorage.key(index) || "";
          // Supabase keeps the session under sb-<project>-auth-token.
          if (/^sb-.+-auth-token$/.test(key) && localStorage.getItem(key)) { state = "shell"; break; }
        }
    }
    if (state === "shell") {
      var named = query.get("view") || "";
      var view = /^(home|canvas|schedule|connect|brand|billing|templates|personas|clone)$/.test(named) ? named : query.has("campaign") || query.has("item") ? "canvas" : "home";
      // Templates has two tabs, each with its own skeleton (the format grid, or the clone form); `?view=clone` is the
      // older address of the second. Personas is a card grid without tabs.
      if (view === "clone" || (view === "templates" && query.get("tab") === "clone")) view = "clone";
      root.setAttribute("data-boot-view", view === "home" || view === "canvas" ? view : view === "templates" ? "formats" : view === "personas" ? "grid" : view === "clone" ? "clone" : "page");
      if (localStorage.getItem("faceful:sidebar") === "collapsed") root.setAttribute("data-boot-sidebar", "collapsed");
      if (localStorage.getItem("faceful:panel") === "closed") root.setAttribute("data-boot-panel", "closed");
    }
  } catch {
    // Storage can throw in private windows. Whatever was decided so far stands.
  }
  root.setAttribute("data-boot", state);
}

/** Remembers whether the right-hand panel was open, so the next load reserves (or does not reserve) its column. */
export function rememberPanel(open: boolean) {
  try { localStorage.setItem("faceful:panel", open ? "open" : "closed"); } catch { /* preference only */ }
}

let covering = typeof document !== "undefined" && document.documentElement.dataset.boot === "shell";
let revealedAt = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const boot = {
  /** True when the page was opened expecting a studio (see `bootProbe`). */
  expectsStudio: () => document.documentElement.dataset.boot === "shell",
  /** Re-reads the page state. Call once at startup, after `data-fixtures` is known. */
  probe() { bootProbe(); covering = document.documentElement.dataset.boot === "shell"; listeners.forEach((listener) => listener()); },
  /** Shows the skeleton over the app (a studio is on its way) or lets the content underneath through. */
  cover(next: boolean) {
    if (covering === next) return;
    if (next) { bootProbe(); document.documentElement.dataset.boot = "shell"; }
    else revealedAt = performance.now();
    covering = next;
    listeners.forEach((listener) => listener());
  },
  /** True while the skeleton is up or has only just lifted: content mounting now should not play an entrance. */
  settling: () => covering || performance.now() - revealedAt < 600,
};

/** The skeleton markup. No text and no data: only the frame every studio view shares, plus five body variants. */
export function ShellSkeleton({ leaving = false, entering = false, age }: { leaving?: boolean; entering?: boolean; age?: number }) {
  return (
    <div className="boot" role="status" aria-label="Opening your studio" aria-busy={!leaving} data-leaving={leaving ? "" : undefined} data-entering={entering ? "" : undefined} style={age === undefined ? undefined : ({ "--boot-age": `${age}ms` } as CSSProperties)}>
      <div className="boot-shell" aria-hidden="true">
        <div className="boot-sidebar">
          <div className="boot-brand"><span className="boot-mark"><i /><i /><i /></span><span className="boot-word">Faceful</span></div>
          <i className="boot-field" />
          <i className="boot-row" /><i className="boot-row" /><i className="boot-row" />
          <i className="boot-label" />
          <i className="boot-row is-current" />
          <span className="boot-user"><i /><i /></span>
        </div>
        <div className="boot-main">
          <div className="boot-topbar"><i /><i /><i /></div>
          <div className="boot-view boot-home"><i className="boot-title" /><i className="boot-line" /><i className="boot-composer" /><span className="boot-chips"><i /><i /><i /><i /></span></div>
          <div className="boot-view boot-canvas"><span className="boot-head"><i className="boot-title" /><i className="boot-line" /></span><span className="boot-cards"><i /><i /><i /></span></div>
          <div className="boot-view boot-page"><i className="boot-title" /><i className="boot-line" /><i className="boot-block" /><i className="boot-block" /></div>
          <div className="boot-view boot-grid"><i className="boot-title" /><i className="boot-line" /><span className="boot-tabs"><i /><i /></span><span className="boot-posters"><i /><i /><i /><i /><i /></span></div>
          <div className="boot-view boot-clone"><i className="boot-title" /><i className="boot-line" /><span className="boot-tabs"><i /><i /></span><span className="boot-clone-body"><span className="boot-clone-form"><i /><i className="is-area" /><i className="is-chips" /></span><i className="boot-clone-frame" /><i className="boot-clone-frame" /></span></div>
          <div className="boot-dock"><i /><i /><i /><i /></div>
        </div>
        <div className="boot-panel"><span className="boot-panel-head"><i /><i /></span><i className="boot-composer" /></div>
      </div>
    </div>
  );
}

/**
 * Keeps exactly one skeleton over the app from first paint until the studio underneath is complete, then
 * cross-fades it out (opacity only; the shell beneath already has its final geometry).
 */
export function BootLayer() {
  const active = useSyncExternalStore(subscribe, () => covering);
  // `initial` is true only for the instance that replaces the static page: it must appear at once, not fade in.
  const [initial] = useState(active);
  // The static page's skeleton has been breathing since navigation started; the React one continues in phase.
  const [age] = useState(() => Math.round(performance.now()));
  const [mounted, setMounted] = useState(active);
  if (active && !mounted) setMounted(true);
  useEffect(() => {
    if (active || !mounted) return;
    // The fade is 180ms; the timer also covers browsers that skip the transition (reduced motion, hidden tab).
    const timer = window.setTimeout(() => setMounted(false), 240);
    return () => window.clearTimeout(timer);
  }, [active, mounted]);
  useEffect(() => {
    // While the skeleton is up, first-load entrances underneath are suppressed (see design.css).
    const root = document.documentElement;
    if (active) { root.setAttribute("data-booting", ""); return; }
    const timer = window.setTimeout(() => root.removeAttribute("data-booting"), 1200);
    return () => window.clearTimeout(timer);
  }, [active]);
  if (!mounted) return null;
  return <ShellSkeleton leaving={!active} entering={!initial} age={initial ? age : undefined} />;
}
