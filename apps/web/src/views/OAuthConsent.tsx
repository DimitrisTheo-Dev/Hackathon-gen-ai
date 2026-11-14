import { useEffect, useState } from "react";
import { Check, LoaderCircle, Plug, X } from "lucide-react";
import { supabase } from "../lib/supabase";
import { Mark, Notice } from "../components/ui";

type Details = { clientName: string; redirectHost: string; scope: string };

function host(url: string) {
  try { return new URL(url).host; } catch { return ""; }
}

/**
 * Consent screen for an external agent connecting through OAuth. Supabase Auth is the
 * authorization server; this page only shows who is asking and records the person's answer.
 */
export function OAuthConsent({ authorizationId, email, onSignOut }: { authorizationId: string; email: string | null; onSignOut: () => void }) {
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"allow" | "deny" | "redirect" | null>(null);
  useEffect(() => {
    let active = true;
    if (!authorizationId) { setError("This connection link is incomplete. Start the connection again from your agent."); return; }
    if (!supabase) { setError("Sign-in is not configured for this deployment."); return; }
    supabase.auth.oauth.getAuthorizationDetails(authorizationId)
      .then(({ data, error: failure }) => {
        if (!active) return;
        if (failure || !data) { setError("This connection request has expired or is no longer valid. Start the connection again from your agent."); return; }
        // Already approved earlier: Supabase returns only the redirect, so continue without asking twice.
        if ("redirect_url" in data) { setBusy("redirect"); location.assign(data.redirect_url); return; }
        setDetails({ clientName: data.client.name || "An application", redirectHost: host(data.redirect_uri), scope: data.scope });
      })
      .catch(() => { if (active) setError("We couldn’t load this connection request. Check your connection and try again."); });
    return () => { active = false; };
  }, [authorizationId]);
  async function decide(allow: boolean) {
    if (!supabase || busy) return;
    setBusy(allow ? "allow" : "deny"); setError("");
    try {
      const call = allow ? supabase.auth.oauth.approveAuthorization : supabase.auth.oauth.denyAuthorization;
      const { data, error: failure } = await call.call(supabase.auth.oauth, authorizationId, { skipBrowserRedirect: true });
      if (failure || !data?.redirect_url) throw failure ?? new Error("No redirect returned");
      location.assign(data.redirect_url);
    } catch {
      setBusy(null);
      setError(allow ? "Access could not be granted. Nothing was shared. Try again, or restart the connection from your agent." : "The request could not be declined here. You can close this page; no access was granted.");
    }
  }
  return (
    <div className="auth-page">
      <a className="wordmark" href="/"><Mark />Faceful</a>
      <main className="auth-card consent-card">
        <span className="auth-symbol"><Plug size={24} aria-hidden="true" /></span>
        <h1>{details ? `Connect ${details.clientName} to Faceful?` : error ? "This connection can’t continue" : "Checking the connection request…"}</h1>
        {!details && !error && <LoaderCircle className="spin" aria-label="Loading the connection request" />}
        {busy === "redirect" && <p role="status">You already approved this application. Returning you to it…</p>}
        {details && busy !== "redirect" && <>
          <p><strong>{details.clientName}</strong> wants to work in your Faceful workspace{email ? <> as <strong>{email}</strong></> : null}.{details.redirectHost && <> After you answer, you’ll return to <strong>{details.redirectHost}</strong>.</>}</p>
          <div className="consent-lists">
            <section aria-labelledby="consent-can">
              <h2 id="consent-can">It will be able to</h2>
              <ul>
                <li><Check size={15} aria-hidden="true" />Read your projects, drafts and videos</li>
                <li><Check size={15} aria-hidden="true" />Create and edit drafts</li>
                <li><Check size={15} aria-hidden="true" />Request renders within your credits</li>
                <li><Check size={15} aria-hidden="true" />Prepare a schedule for your review</li>
              </ul>
            </section>
            <section aria-labelledby="consent-cannot">
              <h2 id="consent-cannot">It will not be able to</h2>
              <ul>
                <li><X size={15} aria-hidden="true" />Approve or publish posts</li>
                <li><X size={15} aria-hidden="true" />Manage billing or see payment details</li>
                <li><X size={15} aria-hidden="true" />Create or revoke access tokens</li>
              </ul>
            </section>
          </div>
          <div className="consent-actions">
            <button className="button primary" disabled={busy !== null} onClick={() => void decide(true)}>{busy === "allow" ? "Allowing…" : "Allow access"}</button>
            <button className="button secondary" disabled={busy !== null} onClick={() => void decide(false)}>{busy === "deny" ? "Declining…" : "Deny"}</button>
          </div>
          <small>Only allow applications you started connecting yourself. You can sign out or revoke access later.</small>
        </>}
        {error && <Notice error>{error}</Notice>}
        <div className="auth-actions">
          <a className="quiet-link" href="/docs/mcp/">How agent connections work</a>
          <button className="text-button" type="button" onClick={onSignOut}>Use a different account</button>
        </div>
      </main>
    </div>
  );
}
