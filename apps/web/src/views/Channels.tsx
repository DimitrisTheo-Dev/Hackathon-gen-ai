import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Instagram, LoaderCircle, Music2, Youtube } from "lucide-react";
import type { StudioContext } from "@castroom/contracts";
import { ApiError, type ChannelConnection, type ChannelStatus, type StudioClient } from "../data/client";
import { Notice } from "../components/ui";
import { supabase } from "../lib/supabase";

/**
 * Publishing channels. One destination is real: YouTube, connected through Google's own consent
 * screen. Instagram and TikTok are shown as unavailable rather than imitated.
 *
 * Flow: "Connect YouTube" → Google asks which account and channel → Google returns here once with
 * short-lived channel tokens → they go straight to the engine, which verifies them with Google and
 * stores an encrypted grant → the session is refreshed so the tokens leave this browser.
 * Nothing on this screen is "connected" unless the engine has a verified connection.
 */
export const YOUTUBE_SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
const PENDING_KEY = "faceful:connect-youtube";
const PENDING_TTL_MS = 15 * 60_000;

type ReturnOutcome = { kind: "none" } | { kind: "connected"; channel: ChannelConnection } | { kind: "error"; message: string };

/** Where Google sends the person back to. The schedule view is where channels are chosen. */
export function youtubeReturnUrl(origin: string, pathname: string): string {
  const base = pathname.startsWith("/dev/studio") ? "/dev/studio/" : "/studio/";
  return `${origin}${base}?view=schedule&connect=youtube`;
}

/** What is asked of Google. An already-linked Google account is re-consented in place; otherwise Google shows its account chooser. */
export function youtubeOAuthOptions(input: { origin: string; pathname: string; alreadyLinked: boolean; email: string | null }) {
  return {
    scopes: YOUTUBE_SCOPES,
    redirectTo: youtubeReturnUrl(input.origin, input.pathname),
    queryParams: {
      // offline + consent: Google only issues the lasting grant the engine needs when both are present.
      access_type: "offline",
      prompt: input.alreadyLinked ? "consent" : "consent select_account",
      ...(input.alreadyLinked && input.email ? { login_hint: input.email } : {}),
    },
  };
}

export function connectErrorMessage(description: string | null): string {
  const text = (description ?? "").toLowerCase();
  if (text.includes("already linked") || text.includes("identity_already_exists") || text.includes("already exists"))
    return "That Google account already belongs to a different Faceful account. Choose another Google account, or sign in with that one.";
  if (text.includes("manual linking")) return "Connecting a Google account isn’t enabled for this workspace’s sign-in yet. Nothing was connected.";
  if (text.includes("access_denied") || text.includes("denied")) return "Google access wasn’t granted, so no channel was connected.";
  return "Google didn’t complete the connection. Nothing was connected — try again.";
}

function readPending(): { userId: string } | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId?: unknown; startedAt?: unknown };
    if (typeof parsed.userId !== "string" || typeof parsed.startedAt !== "number" || Date.now() - parsed.startedAt > PENDING_TTL_MS) return null;
    return { userId: parsed.userId };
  } catch {
    return null;
  }
}

async function finishReturn(client: StudioClient): Promise<ReturnOutcome> {
  const initial = new URL(location.href);
  if (initial.searchParams.get("connect") !== "youtube") return { kind: "none" };
  const hash = new URLSearchParams(initial.hash.replace(/^#/, ""));
  const providerError = initial.searchParams.get("error_description") ?? hash.get("error_description") ?? initial.searchParams.get("error") ?? hash.get("error");
  // Wait for the sign-in library to read Google's response from the address bar before tidying it.
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  const url = new URL(location.href);
  for (const name of ["connect", "error", "error_code", "error_description"]) url.searchParams.delete(name);
  if (/(^|[#&])(error|error_description)=/.test(url.hash)) url.hash = "";
  history.replaceState(history.state, "", url);

  const pending = readPending();
  // No record that this tab started a connection: a reload or an old link. Nothing to finish.
  if (!pending) return { kind: "none" };
  if (providerError) return { kind: "error", message: connectErrorMessage(providerError) };
  if (!supabase || !session) return { kind: "error", message: "Your sign-in ended before the channel could be connected. Sign in and try again." };
  if (session.user.id !== pending.userId) {
    // Google signed a different Faceful account in. Never carry on as someone else: end that session.
    await supabase.auth.signOut().catch(() => undefined);
    return { kind: "error", message: "Google signed in a different Faceful account, so you’ve been signed out and nothing was connected. Sign in again and connect with your own Google account." };
  }
  const accessToken = session.provider_token;
  const refreshToken = session.provider_refresh_token;
  if (!accessToken || !refreshToken)
    return { kind: "error", message: "Google didn’t return lasting access to the channel. Try again and allow every permission Google lists." };
  try {
    const channel = await client.connectChannel({ platform: "youtube", accessToken, refreshToken, operationKey: crypto.randomUUID() });
    return { kind: "connected", channel };
  } catch (error) {
    return { kind: "error", message: error instanceof ApiError ? error.message : "The channel couldn’t be connected. Nothing was saved — try again." };
  } finally {
    // The engine now holds the grant (or refused it). Refreshing replaces the stored session with one
    // that no longer carries Google's tokens, so they do not linger in this browser.
    await supabase.auth.refreshSession().catch(() => undefined);
  }
}

// One completion per page load, even if this component is mounted in two places.
let returnInFlight: Promise<ReturnOutcome> | null = null;
function completeYoutubeReturn(client: StudioClient) {
  returnInFlight ??= finishReturn(client);
  return returnInFlight;
}

async function startYoutubeConnect(): Promise<string | null> {
  if (!supabase) return "Sign-in isn’t configured on this deployment, so a channel can’t be connected.";
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  if (!user) return "Sign in to connect a channel.";
  const identities = (await supabase.auth.getUserIdentities()).data?.identities ?? [];
  const alreadyLinked = identities.some((identity) => identity.provider === "google");
  const options = youtubeOAuthOptions({ origin: location.origin, pathname: location.pathname, alreadyLinked, email: user.email ?? null });
  // Remember who started this, so the return can refuse to continue as anyone else. Not a secret.
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ userId: user.id, startedAt: Date.now() }));
  let { error } = alreadyLinked ? await supabase.auth.signInWithOAuth({ provider: "google", options }) : await supabase.auth.linkIdentity({ provider: "google", options });
  // The account gained a Google identity since the list was read: ask Google to re-consent that same account instead.
  if (error && !alreadyLinked && /already/i.test(`${(error as { code?: string }).code ?? ""} ${error.message}`))
    ({ error } = await supabase.auth.signInWithOAuth({ provider: "google", options: youtubeOAuthOptions({ origin: location.origin, pathname: location.pathname, alreadyLinked: true, email: user.email ?? null }) }));
  if (!error) return null; // the browser is now on its way to Google
  sessionStorage.removeItem(PENDING_KEY);
  return connectErrorMessage(`${(error as { code?: string }).code ?? ""} ${error.message}`);
}

const platformLabel = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" } as const;
const platformIcon = { youtube: Youtube, instagram: Instagram, tiktok: Music2 } as const;

export function Channels({ context, client, onChanged }: { context: StudioContext; client: StudioClient; onChanged: () => Promise<void> }) {
  const headingId = useId();
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"starting" | "finishing" | "disconnecting" | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const disconnectButtons = useRef(new Map<string, HTMLButtonElement>());
  const active = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await client.getChannels();
      if (!active.current) return;
      setStatus(next);
      setLoadError("");
    } catch (failure) {
      if (!active.current) return;
      setLoadError(
        failure instanceof ApiError && failure.code === "unsupported"
          ? "Publishing channels aren’t available in this local preview."
          : failure instanceof Error
            ? failure.message
            : "Channels couldn’t be loaded.",
      );
    }
  }, [client]);

  useEffect(() => {
    active.current = true;
    const returning = new URLSearchParams(location.search).get("connect") === "youtube";
    if (returning) setBusy("finishing");
    void (async () => {
      const outcome = returning ? await completeYoutubeReturn(client) : ({ kind: "none" } as ReturnOutcome);
      if (!active.current) return;
      if (outcome.kind === "connected") {
        setNotice(`Connected to ${outcome.channel.displayName}.`);
        await onChanged().catch(() => undefined);
      } else if (outcome.kind === "error") setError(outcome.message);
      await load();
      if (active.current) setBusy(null);
    })();
    return () => {
      active.current = false;
    };
    // Runs once per mount: `onChanged` is the caller's refresh and may change identity between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, load]);

  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
  }, [confirming]);

  async function connect() {
    if (busy) return;
    setBusy("starting");
    setError("");
    setNotice("");
    const problem = await startYoutubeConnect().catch(() => "Google couldn’t be reached. Check your connection and try again.");
    if (problem && active.current) {
      setError(problem);
      setBusy(null);
    }
  }

  async function disconnect(connection: ChannelConnection) {
    if (busy) return;
    setBusy("disconnecting");
    setError("");
    setNotice("");
    try {
      const result = await client.disconnectChannel({ connectionId: connection.id, operationKey: crypto.randomUUID() });
      if (!active.current) return;
      setConfirming(null);
      setNotice(
        `Disconnected ${connection.displayName}.${result.cancelledPosts ? ` ${result.cancelledPosts} unsent post${result.cancelledPosts === 1 ? " was" : "s were"} cancelled.` : ""}${result.revokedAtGoogle ? "" : " To remove access at Google too, open your Google account’s third-party access."}`,
      );
      await onChanged().catch(() => undefined);
      await load();
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "The channel couldn’t be disconnected. Nothing changed.");
    } finally {
      if (active.current) setBusy(null);
    }
  }

  function closeConfirm(id: string) {
    setConfirming(null);
    requestAnimationFrame(() => disconnectButtons.current.get(id)?.focus());
  }

  const youtube = status?.platforms.find((entry) => entry.platform === "youtube") ?? null;
  const youtubeConnections = status?.connections.filter((entry) => entry.platform === "youtube") ?? [];
  const canManage = Boolean(status?.canManage);
  const working = busy !== null;

  return (
    <section className="channels" aria-labelledby={headingId} aria-busy={working}>
      <header className="channels-head">
        <h2 id={headingId}>Publishing channels</h2>
        <p>Choose where approved videos are posted. Nothing is posted until you approve an exact schedule.</p>
      </header>
      {error && (
        <Notice error>
          {error}
          <button className="text-button" onClick={() => setError("")}>Dismiss</button>
        </Notice>
      )}
      <p className="channels-status" role="status" aria-live="polite">
        {notice && (
          <>
            <Check size={14} aria-hidden="true" />
            {notice}
          </>
        )}
      </p>
      {loadError ? (
        <div className="channels-unavailable">
          <p>{loadError}</p>
          {context.capabilities.mode === "live" && (
            <button className="button secondary" onClick={() => void load()}>
              Try again
            </button>
          )}
        </div>
      ) : !status ? (
        <p className="channels-loading" role="status">
          <LoaderCircle size={14} className="spin" aria-hidden="true" />
          {busy === "finishing" ? "Finishing with Google…" : "Loading channels…"}
        </p>
      ) : (
        <ul className="channel-list">
          <li className="channel-card" data-availability={youtube?.availability ?? "not_configured"}>
            <span className="channel-icon" aria-hidden="true">
              <Youtube size={18} />
            </span>
            <div className="channel-body">
              <h3>YouTube</h3>
              {busy === "finishing" ? (
                <p className="channel-meta" role="status">
                  <LoaderCircle size={13} className="spin" aria-hidden="true" />
                  Finishing with Google…
                </p>
              ) : youtube?.availability !== "ready" ? (
                <p className="channel-meta">{youtube?.reason ?? "YouTube publishing has not been set up on this deployment."}</p>
              ) : youtubeConnections.length === 0 ? (
                <p className="channel-meta">{canManage ? "Not connected. Google will ask which account and channel to use." : "Not connected. A workspace owner or admin can connect a channel."}</p>
              ) : null}
              {youtubeConnections.length > 0 && (
                <ul className="channel-connections">
                  {youtubeConnections.map((connection) => (
                    <li key={connection.id}>
                      <div className="channel-connection">
                        <strong>{connection.displayName}</strong>
                        <span className={`channel-chip ${connection.state}`}>
                          {connection.state === "connected" && <Check size={11} aria-hidden="true" />}
                          {connection.state === "connected" ? "Connected" : "Reconnect needed"}
                        </span>
                      </div>
                      {canManage &&
                        (confirming === connection.id ? (
                          <div className="channel-confirm" role="group" aria-label={`Disconnect ${connection.displayName}`}>
                            <p>Disconnect this channel? Posts that haven’t been sent will be cancelled. Videos already on YouTube stay there.</p>
                            <div>
                              <button ref={cancelButton} className="button secondary" disabled={working} onClick={() => closeConfirm(connection.id)}>
                                Keep connected
                              </button>
                              <button className="button danger" disabled={working} onClick={() => void disconnect(connection)}>
                                {busy === "disconnecting" ? "Disconnecting…" : "Disconnect"}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="channel-row-actions">
                            {connection.state !== "connected" && (
                              <button className="button primary" disabled={working} onClick={() => void connect()}>
                                {busy === "starting" ? "Opening Google…" : "Reconnect"}
                              </button>
                            )}
                            <button
                              ref={(element) => {
                                if (element) disconnectButtons.current.set(connection.id, element);
                                else disconnectButtons.current.delete(connection.id);
                              }}
                              className="text-button"
                              disabled={working}
                              onClick={() => setConfirming(connection.id)}
                            >
                              Disconnect
                            </button>
                          </div>
                        ))}
                    </li>
                  ))}
                </ul>
              )}
              {youtube?.availability === "ready" && youtubeConnections.length > 0 && (
                <details className="channel-note">
                  <summary>How public posts reach YouTube</summary>
                  <p>
                    A public post is uploaded as private with its release time, and YouTube publishes it then. {youtube.note} Until then the post shows as
                    Accepted, with the video’s ID.
                  </p>
                </details>
              )}
            </div>
            {youtube?.availability === "ready" && canManage && busy !== "finishing" && youtubeConnections.length === 0 && (
              <div className="channel-action">
                <button className="button primary" disabled={working} onClick={() => void connect()}>
                  {busy === "starting" ? "Opening Google…" : "Connect YouTube"}
                </button>
              </div>
            )}
          </li>
          {status.platforms
            .filter((entry) => entry.platform !== "youtube")
            .map((entry) => {
              const Icon = platformIcon[entry.platform];
              return (
                <li className="channel-card" data-availability="unavailable" key={entry.platform}>
                  <span className="channel-icon" aria-hidden="true">
                    <Icon size={18} />
                  </span>
                  <div className="channel-body">
                    <h3>{platformLabel[entry.platform]}</h3>
                    <p className="channel-meta">Not available yet — needs platform app review.</p>
                  </div>
                </li>
              );
            })}
        </ul>
      )}
    </section>
  );
}
