// First: zod must be configured before any schema is built (see lib/zod-setup.ts).
import "./lib/zod-setup";
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { LandingPage } from "./landing/LandingPage";
import "./style.css";
import "./mobile.css";
import "./director/director.css";
import "./landing/landing.css";
import "./live.css";
// Sign-in, agent connection, consent, billing and templates. Loaded last: it fully describes those surfaces.
import "./onboarding.css";
import { boot, BootLayer } from "./components/ShellSkeleton";

declare const __FIXTURE_ENABLED__: boolean;

const loadAuthApp = () => import("./AuthApp");
const AuthApp = lazy(loadAuthApp);
const ClaudeVpsPage = lazy(() => import("./claude/ClaudeVpsPage"));
// A presentation surface for the one-minute pitch: noindex, not linked from the product.
const PitchPage = lazy(() => import("./pitch/PitchPage"));
const pitchRoute = /^\/pitch(\/|$)/.test(location.pathname);
const LogosPage = lazy(() => import("./logos/LogosPage"));
// `/logos` holds logo redesign proposals; it is a design review page, not part of the product.
const logosRoute = /^\/logos(\/|$)/.test(location.pathname);
const claudeRoute = /^\/claude-login-test(\/|$)/.test(location.pathname);
// `/oauth/consent` is where an external agent's OAuth request is reviewed, and `/face-scan` is the likeness
// capture; both share the signed-in shell.
const privateRoute = /^\/(studio|dev|oauth|face-scan)(\/|$)/.test(location.pathname);
if (privateRoute) {
  // Decided here, synchronously, before the first render: skeleton (a studio is coming), sign-in card, or neither.
  // The static studio page has already made the same decision with the same function before its first paint.
  document.documentElement.toggleAttribute("data-fixtures", __FIXTURE_ENABLED__);
  boot.probe();
  // Start every chunk the studio needs at once instead of discovering them one after another.
  void loadAuthApp();
  if (boot.expectsStudio()) {
    void import("./views/Studio");
    if (__FIXTURE_ENABLED__ && location.pathname.startsWith("/dev/studio")) void import("./data/fixture");
  }
}
createRoot(document.getElementById("root")!).render(pitchRoute ? <Suspense fallback={null}><PitchPage /></Suspense> : logosRoute ? <Suspense fallback={<div className="loading-page"><p>Opening the logo review…</p></div>}><LogosPage /></Suspense> : claudeRoute ? <Suspense fallback={<div className="loading-page"><p>Opening Claude Code…</p></div>}><ClaudeVpsPage /></Suspense> : privateRoute ? <><Suspense fallback={null}><AuthApp /></Suspense><BootLayer /></> : <LandingPage />);

// Installable app: the worker caches only immutable static assets and an offline page (see public/sw.js).
// Skipped under automation so browser tests always exercise the network path.
if (import.meta.env.PROD && "serviceWorker" in navigator && !navigator.webdriver)
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined));
