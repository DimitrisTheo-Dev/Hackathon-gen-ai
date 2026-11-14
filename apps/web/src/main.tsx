import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { LandingPage } from "./landing/LandingPage";
import "./style.css";
import "./mobile.css";
import "./director/director.css";
import "./landing/landing.css";
import "./live.css";
const AuthApp = lazy(() => import("./AuthApp"));
// `/oauth/consent` is where an external agent's OAuth request is reviewed; it shares the signed-in shell.
const privateRoute = /^\/(studio|dev|oauth)(\/|$)/.test(location.pathname);
createRoot(document.getElementById("root")!).render(privateRoute ? <Suspense fallback={<div className="loading-page"><p>Opening your studio…</p></div>}><AuthApp /></Suspense> : <LandingPage />);

// Installable app: the worker caches only immutable static assets and an offline page (see public/sw.js).
// Skipped under automation so browser tests always exercise the network path.
if (import.meta.env.PROD && "serviceWorker" in navigator && !navigator.webdriver)
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined));
