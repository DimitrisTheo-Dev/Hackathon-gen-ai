import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { LoaderCircle } from "lucide-react";
import { supabase } from "./lib/supabase";
import { EMAIL_CODE_LENGTH, emailAuthError, normalizeEmailCode, requestEmailCode, verifyEmailCode } from "./lib/email-auth";
import type { StudioClient } from "./data/client";
import { createLiveClient } from "./data/live";
const Studio = lazy(() => import("./views/Studio").then((m) => ({ default: m.Studio })));
const OAuthConsent = lazy(() => import("./views/OAuthConsent").then((m) => ({ default: m.OAuthConsent })));
import { Mark, Notice } from "./components/ui";
import { boot } from "./components/ShellSkeleton";

declare const __FIXTURE_ENABLED__: boolean;

/** Quiet full-screen state while an agent's connection request is checked. The studio itself never uses it:
 *  its one loading visual is the shell skeleton (components/ShellSkeleton.tsx). */
function Entering({ label }: { label: string }) {
  return (
    <div className="ob-entering" role="status">
      <span className="ob-emblem ob-emblem-breathing" aria-hidden="true"><Mark /></span>
      <p>{label}</p>
    </div>
  );
}

/** If the studio's code cannot be fetched or fails while opening, say so. Without this the page would stay
 *  on the skeleton (or go blank) with nothing to do. */
class StudioBoundary extends Component<{ children: ReactNode; onFailed: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailed(); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="auth-page">
        <a className="wordmark" href="/"><Mark />Faceful</a>
        <main className="auth-card">
          <h1>The studio couldn’t open.</h1>
          <p>Part of the app didn’t load. Check your connection, then reload the page.</p>
          <button className="button primary" onClick={() => location.reload()}>Reload</button>
          <a href="/docs/errors/">Troubleshooting</a>
        </main>
      </div>
    );
  }
}

function GoogleMark() {
  // Google's "G", shown only on the control that signs in with Google.
  return (
    <svg className="ob-google-mark" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

export default function AuthApp() {
  const isFixture = location.pathname.startsWith("/dev/studio") && __FIXTURE_ENABLED__;
  const [client, setClient] = useState<StudioClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  // With no stored session the sign-in card is the first thing rendered: there is nothing to wait for.
  const [loading, setLoading] = useState(() => document.documentElement.dataset.boot !== "auth");
  // True once the studio has drawn itself completely; until then the shell skeleton stays over it.
  const [studioReady, setStudioReady] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeFocused, setCodeFocused] = useState(false);
  const [busy, setBusy] = useState<"request" | "verify" | "signout" | "google" | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [verifyRetryAt, setVerifyRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [status, setStatus] = useState("");
  const operationPending = useRef(false);
  const emailInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  // The last code that was submitted automatically, so one wrong code is never retried in a loop.
  const autoSubmitted = useRef("");
  const secondsRemaining = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const verifySecondsRemaining = Math.max(0, Math.ceil((verifyRetryAt - now) / 1000));
  // An external agent's OAuth request lands here; the person signs in (if needed) and answers it.
  const isConsent = location.pathname.startsWith("/oauth/consent");
  const isStudio = location.pathname.startsWith("/studio") || isFixture || isConsent;
  const step = session ? "stuck" : pendingEmail ? "code" : "email";
  // The session has arrived and its client is created by the next effect; nothing else may flash in between.
  const openingStudio = Boolean(session) && !client && !error && !isConsent && isStudio;
  // One continuous skeleton from first paint until the studio is complete: while a stored session is restored,
  // while the studio's code and data load, and after an interactive sign-in.
  const covering = isStudio && !isConsent && (client ? !studioReady : loading ? boot.expectsStudio() : openingStudio);
  useLayoutEffect(() => { boot.cover(covering); }, [covering]);
  useEffect(() => { if (!client) setStudioReady(false); }, [client]);

  useEffect(() => {
    const deadline = Math.max(resendAt, verifyRetryAt);
    const timestamp = Date.now();
    setNow(timestamp);
    if (!deadline || timestamp >= deadline) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= deadline) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendAt, verifyRetryAt]);

  useEffect(() => {
    let active = true;
    if (!isStudio) { setLoading(false); return; }
    if (isFixture && __FIXTURE_ENABLED__) {
      void import("./data/fixture")
        .then((module) => {
          if (!active) return;
          setClient(module.createFixtureClient()); setLoading(false);
        })
        .catch(() => {
          if (!active) return;
          setError("The studio could not load. Reload to try again."); setLoading(false);
        });
      return () => { active = false; };
    }
    if (!supabase) {
      setError("Sign-in is not configured for this deployment."); setLoading(false); return;
    }
    void supabase.auth.getSession()
      .then(({ data, error }) => {
        if (!active) return;
        setSession(data.session);
        if (error) setError("Your saved sign-in could not be restored. Sign in again.");
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError("We couldn’t check your sign-in. Check your connection and try again."); setLoading(false);
      });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession(next);
      if (!next) setClient(null);
      else { setError(""); setCode(""); setPendingEmail(""); }
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [isStudio, isFixture]);

  useEffect(() => {
    // A provider can send the person back with an error instead of a session; say so and clean the URL.
    const params = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : "");
    const query = new URLSearchParams(location.search);
    if (!params.has("error") && !query.has("error")) return;
    setError("Sign-in with Google didn’t complete. Try again, or use an email code instead.");
    query.delete("error"); query.delete("error_code"); query.delete("error_description");
    const rest = query.toString();
    history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}`);
  }, []);

  useEffect(() => {
    if (!session || isFixture || isConsent) return;
    // Same-origin by default: the studio and its API ship as one deployment. No fixture is ever substituted.
    const origin = import.meta.env.VITE_CASTROOM_API_URL || location.origin;
    if (origin)
      try {
        setClient(createLiveClient(origin, async () => {
          const result = await supabase!.auth.getSession();
          return result.data.session?.access_token ?? null;
        }));
      } catch {
        setError("The studio API is not configured correctly. Contact the workspace owner.");
      }
  }, [session, isFixture, isConsent]);

  // Each step hands focus to its one field, so the keyboard never has to hunt for it.
  useEffect(() => {
    if (loading) return;
    if (step === "code") codeInput.current?.focus({ preventScroll: true });
    else if (step === "email" && !matchMedia("(pointer: coarse)").matches) emailInput.current?.focus({ preventScroll: true });
  }, [step, loading]);

  async function signInWithGoogle() {
    if (!supabase || operationPending.current) return;
    operationPending.current = true; setBusy("google"); setError(""); setStatus("");
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        // Return to the consent request when there is one; otherwise to the studio.
        options: { redirectTo: isConsent ? location.href : `${location.origin}/studio/` },
      });
      if (error) throw error;
      // The browser is leaving for Google. The button stays busy until it does.
    } catch {
      setError("We couldn’t start Google sign-in. Try again, or use an email code instead.");
      operationPending.current = false; setBusy(null);
    }
  }
  function cooldown(seconds: number) {
    const timestamp = Date.now();
    setNow(timestamp); setResendAt(timestamp + seconds * 1000);
  }
  async function sendCode(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!supabase || operationPending.current || Date.now() < resendAt) return;
    operationPending.current = true; setBusy("request"); setError(""); setStatus("");
    try {
      const result = await requestEmailCode(supabase.auth, pendingEmail || email);
      setPendingEmail(result.email); setEmail(result.email); setCode(""); autoSubmitted.current = "";
      cooldown(result.retryAfterSeconds);
      setStatus("Code sent.");
    } catch (error) {
      const failure = emailAuthError(error, "request");
      setError(failure.message);
      if (failure.retryAfterSeconds) cooldown(failure.retryAfterSeconds);
    } finally { operationPending.current = false; setBusy(null); }
  }
  const verify = useCallback(async (value: string) => {
    if (!supabase || operationPending.current || Date.now() < verifyRetryAt) return;
    operationPending.current = true; setBusy("verify"); setError(""); setStatus("");
    try {
      const confirmed = await verifyEmailCode(supabase.auth, pendingEmail, value);
      setSession(confirmed); setCode(""); setPendingEmail("");
    } catch (error) {
      const failure = emailAuthError(error, "verify");
      setError(failure.message);
      // Clear the rejected digits so the next code can be typed straight away; focus never left the field.
      setCode("");
      if (failure.retryAfterSeconds) {
        cooldown(failure.retryAfterSeconds);
        setVerifyRetryAt(Date.now() + failure.retryAfterSeconds * 1000);
      }
    } finally { operationPending.current = false; setBusy(null); }
  }, [pendingEmail, verifyRetryAt]);
  // The sixth digit submits by itself; the button stays for people who prefer to press it.
  useEffect(() => {
    if (step !== "code" || code.length !== EMAIL_CODE_LENGTH || busy !== null || autoSubmitted.current === code) return;
    autoSubmitted.current = code;
    void verify(code);
  }, [code, step, busy, verify]);
  async function signOut() {
    if (!supabase || operationPending.current) return;
    operationPending.current = true; setBusy("signout"); setError("");
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      setSession(null); setClient(null); setCode(""); setPendingEmail(""); setStatus("");
    } catch { setError("We couldn’t sign you out. Check your connection and try again."); }
    finally { operationPending.current = false; setBusy(null); }
  }
  function changeEmail() {
    if (operationPending.current) return;
    setPendingEmail(""); setCode(""); setError(""); setStatus(""); autoSubmitted.current = "";
  }

  if (isConsent && session)
    return (
      <Suspense fallback={<Entering label="Checking the connection request…" />}>
        <OAuthConsent authorizationId={new URLSearchParams(location.search).get("authorization_id") ?? ""} email={session.user.email ?? null} onSignOut={() => void signOut()} />
      </Suspense>
    );
  if (client)
    return <>
      {error && <div className="auth-feedback"><Notice error>{error}</Notice></div>}
      <StudioBoundary onFailed={() => setStudioReady(true)}>
        <Suspense fallback={null}>
          <Studio client={client} onSignOut={isFixture ? undefined : () => void signOut()} onReady={() => setStudioReady(true)} />
        </Suspense>
      </StudioBoundary>
    </>;
  if (loading && isConsent) return <Entering label="Opening your workspace…" />;
  // The shell skeleton is over the page; rendering anything here would only flash underneath it.
  if (loading || openingStudio) return null;

  const slots = Array.from({ length: EMAIL_CODE_LENGTH }, (_, index) => code[index] ?? "");
  const caretAt = Math.min(code.length, EMAIL_CODE_LENGTH - 1);
  return (
    <div className="auth-page ob-auth">
      <header className="ob-auth-top"><a className="wordmark" href="/"><Mark />Faceful</a></header>
      <main className="auth-card ob-card" data-step={step}>
        {/* Keyed so each step fades in as one piece instead of morphing field by field. */}
        <div className="ob-step" key={step}>
          {step === "stuck" ? <>
            <h1><Mark />You’re signed in</h1>
            <p className="ob-sub">The studio could not be opened from this address. Nothing was lost; no sample content was substituted.</p>
            <a className="ob-button ob-button-quiet" href="/docs/">View integration status</a>
            <button className="ob-link" type="button" disabled={busy === "signout"} onClick={() => void signOut()}>{busy === "signout" ? "Signing out…" : "Sign out"}</button>
          </> : step === "code" ? <>
            <h1><Mark />Check your email</h1>
            <p className="ob-sub" id="auth-code-help">Enter the 6-digit code we sent to <strong>{pendingEmail}</strong>.</p>
            <form onSubmit={(event) => { event.preventDefault(); void verify(code); }} aria-busy={busy === "verify"} noValidate>
              <label className="sr-only" htmlFor="email-code">Sign-in code</label>
              <div className="ob-code" data-focused={codeFocused || undefined} data-invalid={(Boolean(error) && !code) || undefined} data-busy={busy === "verify" || undefined}>
                <input
                  ref={codeInput}
                  id="email-code"
                  name="code"
                  className="ob-code-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  pattern="[0-9]*"
                  maxLength={12}
                  value={code}
                  // Read-only, not disabled, while verifying: a disabled field would drop focus.
                  readOnly={busy !== null}
                  aria-describedby="auth-code-help"
                  aria-invalid={Boolean(error) && !code ? true : undefined}
                  onChange={(event) => {
                    const next = normalizeEmailCode(event.target.value).replace(/\D/g, "").slice(0, EMAIL_CODE_LENGTH);
                    // Retyping after a rejected code is a new attempt, even when the digits are the same.
                    if (next.length < EMAIL_CODE_LENGTH) autoSubmitted.current = "";
                    if (next && error) setError("");
                    setCode(next);
                  }}
                  onFocus={() => setCodeFocused(true)}
                  onBlur={() => setCodeFocused(false)}
                />
                <div className="ob-code-slots" aria-hidden="true">
                  {slots.map((digit, index) => (
                    <span key={index} className="ob-code-slot" data-filled={digit ? "" : undefined} data-active={codeFocused && busy === null && index === caretAt && code.length < EMAIL_CODE_LENGTH ? "" : undefined}>
                      {digit && <b>{digit}</b>}
                    </span>
                  ))}
                </div>
              </div>
              {error && <p className="ob-error" role="alert">{error}</p>}
              <button className="ob-button ob-button-primary" disabled={!supabase || busy === "request" || verifySecondsRemaining > 0} aria-disabled={busy === "verify" || undefined}>
                {busy === "verify" ? <><LoaderCircle size={16} className="spin" aria-hidden="true" />Verifying…</> : verifySecondsRemaining > 0 ? `Try again in ${verifySecondsRemaining}s` : "Verify and continue"}
              </button>
            </form>
            <div className="ob-code-actions">
              <button className="ob-link" type="button" disabled={busy !== null || secondsRemaining > 0} onClick={() => void sendCode()}>
                {busy === "request" ? "Sending…" : secondsRemaining > 0 ? <span>Resend in <span className="ob-count">{secondsRemaining}s</span></span> : "Resend code"}
              </button>
              <button className="ob-link" type="button" disabled={busy !== null} onClick={changeEmail}>Use a different email</button>
            </div>
          </> : <>
            <h1><Mark />{isConsent ? "Sign in to connect your agent" : "Sign in to Faceful"}</h1>
            {isConsent && <p className="ob-sub">An application asked to work in your workspace. Sign in to review its request.</p>}
            <button className="ob-button ob-button-primary ob-google" type="button" disabled={busy !== null || !supabase} onClick={() => void signInWithGoogle()}>
              <span className="ob-google-chip">{busy === "google" ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <GoogleMark />}</span>
              {busy === "google" ? "Opening Google…" : "Continue with Google"}
            </button>
            <p className="ob-divider" aria-hidden="true"><span>or</span></p>
            <form onSubmit={sendCode} aria-busy={busy === "request"}>
              <label htmlFor="email">Email address</label>
              <input ref={emailInput} id="email" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" required readOnly={busy !== null} aria-describedby="email-help" />
              <small id="email-help">We’ll email you a 6-digit code.</small>
              {error && <p className="ob-error" role="alert">{error}</p>}
              <button className="ob-button ob-button-quiet" data-ready={email.trim() ? "" : undefined} disabled={!supabase || busy === "google" || secondsRemaining > 0} aria-disabled={busy === "request" || undefined}>
                {busy === "request" ? <><LoaderCircle size={16} className="spin" aria-hidden="true" />Sending code…</> : secondsRemaining > 0 ? `Request a code in ${secondsRemaining}s` : "Continue with email"}
              </button>
            </form>
          </>}
          {step === "stuck" && error && <p className="ob-error" role="alert">{error}</p>}
        </div>
        {/* The "Check your email" heading is the visible confirmation; this only announces it to screen readers. */}
        <p className="sr-only" role="status">{session ? "" : status}</p>
      </main>
      <footer className="ob-auth-foot">
        <a href="/docs/">Docs</a>
        <a href="/privacy/">Privacy</a>
      </footer>
    </div>
  );
}
