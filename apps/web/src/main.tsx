import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { LandingPage } from "./landing/LandingPage";
import "./style.css";
import "./landing/landing.css";
const AuthApp = lazy(() => import("./AuthApp"));
const privateRoute = /^\/(studio|dev)(\/|$)/.test(location.pathname);
createRoot(document.getElementById("root")!).render(privateRoute ? <Suspense fallback={<div className="loading-page"><p>Opening your studio…</p></div>}><AuthApp /></Suspense> : <LandingPage />);
