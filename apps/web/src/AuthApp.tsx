import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { ArrowLeft, LockKeyhole, LoaderCircle, Mail } from "lucide-react";
import { supabase } from "./lib/supabase";
import { emailAuthError, normalizeEmailCode, requestEmailCode, verifyEmailCode } from "./lib/email-auth";
import type { StudioClient } from "./data/client";
import { createLiveClient } from "./data/live";
const Studio = lazy(() => import("./views/Studio").then((m) => ({ default: m.Studio })));
const OAuthConsent = lazy(() => import("./views/OAuthConsent").then((m) => ({ default: m.OAuthConsent })));
import { Mark, Notice } from "./components/ui";

declare const __FIXTURE_ENABLED__: boolean;
export default function AuthApp() {
  const isFixture = location.pathname.startsWith("/dev/studio") && __FIXTURE_ENABLED__;
  const [client, setClient] = useState<StudioClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"request" | "verify" | "signout" | "google" | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [verifyRetryAt, setVerifyRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [status, setStatus] = useState("");
  const operationPending = useRef(false);
  const secondsRemaining = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const verifySecondsRemaining = Math.max(0, Math.ceil((verifyRetryAt - now) / 1000));
  // An external agent's OAuth request lands here; the person signs in (if needed) and answers it.
  const isConsent = location.pathname.startsWith("/oauth/consent");
  const isStudio = location.pathname.startsWith("/studio") || isFixture || isConsent;

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
      setError("Authentication is not configured for this deployment."); setLoading(false); return;
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
      setPendingEmail(result.email); setEmail(result.email); setCode("");
      cooldown(result.retryAfterSeconds);
      setStatus("Code sent.");
    } catch (error) {
      const failure = emailAuthError(error, "request");
      setError(failure.message);
      if (failure.retryAfterSeconds) cooldown(failure.retryAfterSeconds);
    } finally { operationPending.current = false; setBusy(null); }
  }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || operationPending.current || Date.now() < verifyRetryAt) return;
    operationPending.current = true; setBusy("verify"); setError(""); setStatus("");
    try {
      const confirmed = await verifyEmailCode(supabase.auth, pendingEmail, code);
      setSession(confirmed); setCode(""); setPendingEmail("");
    } catch (error) {
      const failure = emailAuthError(error, "verify");
      setError(failure.message);
      if (failure.retryAfterSeconds) {
        cooldown(failure.retryAfterSeconds);
        setVerifyRetryAt(Date.now() + failure.retryAfterSeconds * 1000);
      }
    } finally { operationPending.current = false; setBusy(null); }
  }
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
    setPendingEmail(""); setCode(""); setError(""); setStatus("");
  }

  if (isConsent && session)
    return (
      <Suspense fallback={<div className="loading-page"><Mark /><p>Checking the connection request…</p></div>}>
        <OAuthConsent authorizationId={new URLSearchParams(location.search).get("authorization_id") ?? ""} email={session.user.email ?? null} onSignOut={() => void signOut()} />
      </Suspense>
    );
  if (client)
    return <>
      {error && <div className="auth-feedback"><Notice error>{error}</Notice></div>}
      <Suspense fallback={<div className="loading-page"><Mark /><p>Opening your studio…</p></div>}>
        <Studio client={client} onSignOut={isFixture ? undefined : () => void signOut()} />
      </Suspense>
    </>;
  return (
    <div className="auth-page">
      <a className="wordmark" href="/"><Mark />Faceful</a>
      <main className="auth-card">
        <span className="auth-symbol">{pendingEmail ? <Mail size={24} /> : <LockKeyhole size={24} />}</span>
        <h1>{loading ? "Opening your workspace…" : session ? "You’re signed in" : pendingEmail ? "Check your email" : isConsent ? "Sign in to connect your agent" : "Your next campaign starts here."}</h1>
        {loading ? <LoaderCircle className="spin" aria-label="Checking sign-in" /> : session ? <>
          <p>Your email is verified, but the studio could not be opened from this address. Nothing was lost; no sample content was substituted.</p>
          <a className="button secondary" href="/docs/">View integration status</a>
          <button className="text-button" disabled={busy === "signout"} onClick={() => void signOut()}>{busy === "signout" ? "Signing out…" : "Sign out"}</button>
        </> : <>
          {pendingEmail ? <>
            <p>Enter the six-digit code requested for <strong>{pendingEmail}</strong>.</p>
            <form onSubmit={verify} aria-busy={busy === "verify"}>
              <label htmlFor="email-code">Sign-in code</label>
              <input id="email-code" name="code" className="auth-code-input" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={12} value={code} onChange={(event) => setCode(normalizeEmailCode(event.target.value))} aria-describedby="auth-code-help" required disabled={busy !== null} placeholder="000000" />
              <small id="auth-code-help">Use the latest email. You can paste the full code.</small>
              <button className="button primary" disabled={busy !== null || !supabase || verifySecondsRemaining > 0}>{busy === "verify" ? "Verifying code…" : verifySecondsRemaining > 0 ? `Try again in ${verifySecondsRemaining}s` : "Verify and continue"}</button>
            </form>
            <div className="auth-actions">
              <button className="text-button" type="button" disabled={busy !== null || secondsRemaining > 0} onClick={() => void sendCode()}>{busy === "request" ? "Requesting code…" : secondsRemaining > 0 ? `Resend in ${secondsRemaining}s` : "Resend code"}</button>
              <button className="text-button" type="button" disabled={busy !== null} onClick={changeEmail}>Change email</button>
            </div>
          </> : <>
            <p>{isConsent ? "An application asked to work in your Faceful workspace. Sign in to review its request." : "Sign in or create an account with your email. We’ll request a one-time code."}</p>
            <form onSubmit={sendCode} aria-busy={busy === "request"}>
              <label htmlFor="email">Email address</label>
              <input id="email" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" required disabled={busy !== null} />
              <button className="button primary" disabled={busy !== null || !supabase || secondsRemaining > 0}>{busy === "request" ? "Requesting code…" : secondsRemaining > 0 ? `Request a code in ${secondsRemaining}s` : "Continue with email"}</button>
            </form>
            <p className="auth-divider" aria-hidden="true"><span>or</span></p>
            <button className="button secondary auth-provider" type="button" disabled={busy !== null || !supabase} onClick={() => void signInWithGoogle()}>{busy === "google" ? "Opening Google…" : "Continue with Google"}</button>
          </>}
        </>}
        {/* The "Check your email" heading is the visible confirmation; this only announces it to screen readers. */}
        <p className="sr-only" role="status">{session ? "" : status}</p>
        {error && <Notice error>{error}</Notice>}
        <a className="quiet-link" href="/docs/setup/"><ArrowLeft size={14} /> Setup instructions</a>
      </main>
    </div>
  );
}
