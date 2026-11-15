import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Link2, LoaderCircle } from "lucide-react";
import { Mark, Notice } from "../components/ui";
import { ApiError } from "../data/client";
import { supabase } from "../lib/supabase";
import { createSocialsApi, type SocialAccount, type SocialProviderInfo } from "./api";
import "./connect.css";

/**
 * `/studio/connect/<provider>`: connecting an account by signing in to its platform (Instagram, TikTok).
 *
 * The person starts here, leaves for the platform, and is sent back here with a one-time code. The engine passes
 * that code along in the part of the address after `#`, which browsers never send to a server; this page hands it
 * to the engine together with the person's own session. That last step is what makes a link to someone else's
 * sign-in useless: the engine only completes a sign-in for the person who started it.
 */
const notes: Record<string, string> = {
  instagram: "Only professional (business or creator) Instagram accounts can be connected.",
  tiktok: "Until TikTok reviews this app, posts can only be private, and the TikTok account has to be set to private.",
};

/** What the platform's answer left in the address. Read once, then removed so the code is not kept in history. */
let returned: { grant: string | null; ticket: string | null; problem: string | null } | undefined;
function takeReturn() {
  const params = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : "");
  const result = { grant: params.get("grant"), ticket: params.get("ticket"), problem: params.get("problem") };
  if (result.grant || result.problem) history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return result;
}
const message = (failure: unknown) => (failure instanceof ApiError ? failure.message : "Something went wrong. Nothing was connected; try again.");
function accountState(account: SocialAccount) {
  if (account.state === "expired") return { text: "Needs to be connected again", attention: true };
  if (account.state === "unavailable") return { text: "Unavailable", attention: true };
  return { text: account.webhookSubscribedAt ? "Connected · comments and messages on" : "Connected", attention: false };
}

export default function ConnectPage({ provider }: { provider: string }) {
  const api = useMemo(() => createSocialsApi(import.meta.env.VITE_CASTROOM_API_URL || location.origin, async () => (await supabase?.auth.getSession())?.data.session?.access_token ?? null), []);
  const [info, setInfo] = useState<SocialProviderInfo | null>(null);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [busy, setBusy] = useState<"loading" | "finishing" | "leaving" | null>("loading");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState<SocialAccount | null>(null);
  // The code works once, so the completing call is made once however often this effect runs.
  const finishing = useRef(false);

  useEffect(() => {
    let active = true;
    const back = (returned ??= takeReturn());
    const load = async () => {
      const catalog = await api.catalog();
      if (!active) return;
      setInfo(catalog.providers.find((entry) => entry.id === provider) ?? null);
      setAccounts(catalog.platforms.flatMap((platform) => platform.accounts).filter((account) => account.provider === provider));
    };
    void (async () => {
      try {
        if (back.grant && back.ticket && !finishing.current) {
          finishing.current = true;
          setBusy("finishing");
          const result = await api.complete(provider, back.grant, back.ticket);
          if (active) setConnected(result.accounts[0] ?? null);
        } else if (back.problem) setError(back.problem === "declined" ? "You didn’t allow access, so nothing was connected." : "The sign-in didn’t complete. Nothing was connected; try again.");
        await load();
      } catch (failure) {
        if (active) setError(message(failure));
        await load().catch(() => undefined);
      } finally {
        if (active) setBusy(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [api, provider]);

  async function start() {
    setBusy("leaving");
    setError("");
    try {
      location.assign((await api.start(provider)).authorizeUrl);
    } catch (failure) {
      setError(message(failure));
      setBusy(null);
    }
  }

  const label = info?.label ?? "an account";
  const offered = info?.connect === "sign_in";
  const waiting = busy === "loading" || busy === "finishing";
  return (
    // The same card as the sign-in and the agent consent page (onboarding.css); only the list of accounts is its own.
    <div className="auth-page ob-auth">
      <header className="ob-auth-top"><a className="wordmark" href="/"><Mark />Faceful</a></header>
      <main className="auth-card ob-card">
        <div className="ob-step">
          <span className="ob-emblem" aria-hidden="true"><Link2 size={22} strokeWidth={1.75} /></span>
          <h1>{connected ? `${connected.displayName} is connected` : `Connect ${label}`}</h1>
          {waiting ? (
            <p className="ob-sub connect-status" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />{busy === "finishing" ? "Finishing the connection…" : "Checking your workspace…"}</p>
          ) : !offered ? (
            !error && <Notice error>This connection isn’t available here.</Notice>
          ) : (
            <>
              <p className="ob-sub">
                {connected ? "Faceful can now post to this account. " : `You’ll sign in at ${label} and allow Faceful to post for you. `}
                Nothing is posted until you approve a schedule.{notes[provider] ? ` ${notes[provider]}` : ""}
              </p>
              {accounts.length > 0 && (
                <ul className="connect-accounts" aria-label={`Connected ${label} accounts`}>
                  {accounts.map((account) => {
                    const state = accountState(account);
                    return (
                      <li key={account.id}>
                        {account.profileUrl?.startsWith("https://") ? <a href={account.profileUrl} target="_blank" rel="noreferrer">{account.displayName}</a> : <strong>{account.displayName}</strong>}
                        <span className={state.attention ? "attention" : undefined}>{state.text}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {info?.available ? (
                <button className={`ob-button ${accounts.length ? "ob-button-quiet" : "ob-button-primary"}`} type="button" disabled={busy !== null} onClick={() => void start()}>
                  {busy === "leaving" ? `Opening ${label}…` : accounts.length ? "Connect another account" : `Connect ${label}`}
                </button>
              ) : (
                <Notice>Connecting {label} directly isn’t switched on for this deployment yet.</Notice>
              )}
            </>
          )}
          {error && <p className="ob-error" role="alert">{error}</p>}
          <a className="ob-link connect-back" href="/studio/"><ArrowLeft size={14} aria-hidden="true" /> Back to the studio</a>
        </div>
      </main>
    </div>
  );
}
