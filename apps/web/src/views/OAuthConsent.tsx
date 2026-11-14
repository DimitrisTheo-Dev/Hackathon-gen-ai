import { useEffect, useState } from "react";
import { ArrowLeftRight, Check, LoaderCircle, Plug, X } from "lucide-react";
import { supabase } from "../lib/supabase";
import { Mark } from "../components/ui";

type Details = { clientName: string; redirectHost: string; scope: string };

function host(url: string) {
  try { return new URL(url).host; } catch { return ""; }
}

/**
 * Defence in depth around the redirect Supabase returns: agents use http(s) loopback callbacks or their own
 * app schemes (for example `cursor://`), so those pass, but a script-bearing scheme is never navigated to.
 */
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "blob:", "file:"]);
function safeRedirect(url: string): string {
  const parsed = new URL(url);
  if (BLOCKED_SCHEMES.has(parsed.protocol)) throw new Error("Refused redirect scheme");
  return parsed.href;
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
        if ("redirect_url" in data) {
          try { const target = safeRedirect(data.redirect_url); setBusy("redirect"); location.assign(target); }
          catch { setError("This connection request points somewhere unsafe, so it was stopped. Start the connection again from your agent."); }
          return;
        }
        // Checked before the person is asked, so Allow is never offered for a callback we would refuse to follow.
        try { safeRedirect(data.redirect_uri); }
        catch { setError("This connection request points somewhere unsafe, so it was stopped. Start the connection again from your agent."); return; }
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
      location.assign(safeRedirect(data.redirect_url));
    } catch {
      setBusy(null);
      setError(allow ? "Access could not be granted. Nothing was shared. Try again, or restart the connection from your agent." : "The request could not be declined here. You can close this page; no access was granted.");
    }
  }
  const state = details ? "ask" : error ? "error" : "loading";
  return (
    <div className="auth-page ob-auth">
      <header className="ob-auth-top"><a className="wordmark" href="/"><Mark />Faceful</a></header>
      <main className="auth-card consent-card ob-card ob-consent" data-step={state}>
        <div className="ob-step" key={state}>
          <div className="ob-pair" aria-hidden="true">
            <span className="ob-emblem"><Plug size={22} strokeWidth={1.75} /></span>
            <span className="ob-pair-link"><ArrowLeftRight size={14} strokeWidth={2} /></span>
            <span className="ob-emblem"><Mark /></span>
          </div>
          <h1>{details ? `Connect ${details.clientName} to Faceful?` : error ? "This connection can’t continue" : "Checking the connection request…"}</h1>
          {state === "loading" && busy !== "redirect" && (
            <div className="ob-skeleton-lines" role="status">
              <span className="sr-only">Loading the connection request</span>
              <i /><i /><i />
            </div>
          )}
          {busy === "redirect" && <p className="ob-sub" role="status">You already approved this application. Returning you to it…</p>}
          {details && busy !== "redirect" && <>
            <p className="ob-sub"><strong>{details.clientName}</strong> wants to work in your Faceful workspace{email ? <> as <strong>{email}</strong></> : null}.{details.redirectHost && <> After you answer, you’ll return to <strong>{details.redirectHost}</strong>.</>}</p>
            <div className="ob-consent-lists">
              <section aria-labelledby="consent-can">
                <h2 id="consent-can">It will be able to</h2>
                <ul>
                  <li><Check size={15} strokeWidth={2.25} aria-hidden="true" />Read your projects, drafts and videos</li>
                  <li><Check size={15} strokeWidth={2.25} aria-hidden="true" />Create and edit drafts</li>
                  <li><Check size={15} strokeWidth={2.25} aria-hidden="true" />Request renders within your credits</li>
                  <li><Check size={15} strokeWidth={2.25} aria-hidden="true" />Prepare a schedule for your review</li>
                </ul>
              </section>
              <section aria-labelledby="consent-cannot" data-tone="denied">
                <h2 id="consent-cannot">It will not be able to</h2>
                <ul>
                  <li><X size={15} strokeWidth={2.25} aria-hidden="true" />Approve or publish posts</li>
                  <li><X size={15} strokeWidth={2.25} aria-hidden="true" />Manage billing or see payment details</li>
                  <li><X size={15} strokeWidth={2.25} aria-hidden="true" />Create or revoke access tokens</li>
                </ul>
              </section>
            </div>
            <div className="ob-consent-actions">
              <button className="ob-button ob-button-primary" disabled={busy !== null} onClick={() => void decide(true)}>{busy === "allow" ? <><LoaderCircle size={16} className="spin" aria-hidden="true" />Allowing…</> : "Allow access"}</button>
              <button className="ob-button ob-button-quiet" disabled={busy !== null} onClick={() => void decide(false)}>{busy === "deny" ? "Declining…" : "Deny"}</button>
            </div>
            <small className="ob-fine">Only allow applications you started connecting yourself. You can revoke access at any time.</small>
          </>}
          {error && <p className="ob-error" role="alert">{error}</p>}
          <div className="ob-code-actions">
            <a className="ob-link" href="/docs/mcp/">How agent connections work</a>
            <button className="ob-link" type="button" onClick={onSignOut}>Use a different account</button>
          </div>
        </div>
      </main>
    </div>
  );
}
