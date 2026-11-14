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

/**
 * What a person reads when a channel request fails. The engine's own messages for channel problems are
 * written for people (Google refused a permission, the account has no channel…), so those pass through.
 * Anything else — a network failure, a missing route on an outdated server, a sign-in that ended — is
 * replaced by a plain sentence: a raw engine or transport message is never shown here.
 */
export function channelFailure(failure: unknown, fallback: string): string {
  if (!(failure instanceof ApiError)) return fallback;
  if (failure.code === "unauthenticated") return "Your sign-in ended. Sign in again to manage channels.";
  if (failure.code === "not_found" || failure.code === "idempotency_conflict" || !failure.message.trim()) return fallback;
  return failure.message;
}

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
    return { kind: "error", message: channelFailure(error, "The channel couldn’t be connected. Nothing was saved — try again.") };
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
const PLACEHOLDERS = ["youtube", "instagram", "tiktok"] as const;

/**
 * One compact row of channel cards: YouTube (connect, or the connected channel), then the platforms
 * that are not available yet. Loading keeps the same cards in place; a failed load becomes one quiet
 * line with a retry, never an engine message.
 */
export function Channels({ context, client, onChanged }: { context: StudioContext; client: StudioClient; onChanged: () => Promise<void> }) {
  const headingId = useId();
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [loadError, setLoadError] = useState<"unsupported" | "failed" | null>(null);
  const [retrying, setRetrying] = useState(false);
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
      setLoadError(null);
    } catch (failure) {
      if (!active.current) return;
      setLoadError(failure instanceof ApiError && failure.code === "unsupported" ? "unsupported" : "failed");
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

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    await load();
    if (active.current) setRetrying(false);
  }

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
      if (active.current) setError(channelFailure(failure, "The channel couldn’t be disconnected. Nothing changed — try again."));
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
  const confirmingConnection = youtubeConnections.find((connection) => connection.id === confirming) ?? null;
  const others = status ? status.platforms.filter((entry) => entry.platform !== "youtube").map((entry) => entry.platform) : PLACEHOLDERS.filter((platform) => platform !== "youtube");

  return (
    <section className="channels" aria-labelledby={headingId} aria-busy={working || (!status && !loadError)}>
      <header className="channels-head">
        <h2 id={headingId}>Channels</h2>
        <p>Nothing posts until you approve a schedule.</p>
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
        <p className="channels-failed" role={loadError === "failed" ? "alert" : undefined}>
          {loadError === "unsupported" ? (
            "Channels aren’t available in this local preview."
          ) : (
            <>
              <span>Couldn’t load channels</span>
              {context.capabilities.mode === "live" && (
                <>
                  <span aria-hidden="true">·</span>
                  <button className="text-button" disabled={retrying} onClick={() => void retry()}>
                    {retrying ? "Retrying…" : "Retry"}
                  </button>
                </>
              )}
            </>
          )}
        </p>
      ) : (
        <ul className="channel-list">
          <li className="channel-card" data-availability={status ? (youtube?.availability ?? "not_configured") : "loading"} data-connected={youtubeConnections.length > 0 || undefined}>
            <span className="channel-icon" aria-hidden="true">
              <Youtube size={17} />
            </span>
            <div className="channel-body">
              <h3>YouTube</h3>
              {busy === "finishing" ? (
                <p className="channel-meta" role="status">
                  <LoaderCircle size={13} className="spin" aria-hidden="true" />
                  Finishing with Google…
                </p>
              ) : !status ? (
                <p className="channel-meta"><span className="channel-skeleton" aria-hidden="true" /><span className="sr-only">Checking…</span></p>
              ) : youtube?.availability !== "ready" ? (
                <p className="channel-meta" title={youtube?.reason ?? undefined}>Not set up yet</p>
              ) : youtubeConnections.length === 0 ? (
                <p className="channel-meta" title={canManage ? "Google will ask which account and channel to use." : undefined}>{canManage ? "Not connected" : "Ask an admin to connect"}</p>
              ) : (
                youtubeConnections.map((connection) => (
                  <p className="channel-meta channel-connection" key={connection.id}>
                    <strong title={connection.displayName}>{connection.displayName}</strong>
                    <span className={`channel-chip ${connection.state}`}>
                      {connection.state === "connected" && <Check size={11} aria-hidden="true" />}
                      {connection.state === "connected" ? "Connected" : "Reconnect needed"}
                    </span>
                  </p>
                ))
              )}
            </div>
            {status && youtube?.availability === "ready" && canManage && busy !== "finishing" && (
              <div className="channel-action">
                {youtubeConnections.length === 0 ? (
                  <button className="button secondary" aria-label="Connect YouTube" disabled={working} onClick={() => void connect()}>
                    {busy === "starting" ? "Opening Google…" : "Connect"}
                  </button>
                ) : (
                  youtubeConnections.map((connection) => (
                    <span className="channel-row-actions" key={connection.id}>
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
                        aria-label={`Disconnect ${connection.displayName}`}
                        aria-expanded={confirming === connection.id}
                        disabled={working}
                        onClick={() => setConfirming(connection.id)}
                      >
                        Disconnect
                      </button>
                    </span>
                  ))
                )}
              </div>
            )}
          </li>
          {others.map((platform) => {
            const Icon = platformIcon[platform];
            return (
              <li className="channel-card" data-availability={status ? "unavailable" : "loading"} key={platform}>
                <span className="channel-icon" aria-hidden="true">
                  <Icon size={17} />
                </span>
                <div className="channel-body">
                  <h3>{platformLabel[platform]}</h3>
                  {status ? (
                    <p className="channel-meta" title="Needs the platform’s app review before posts can be sent.">Not available yet</p>
                  ) : (
                    <p className="channel-meta"><span className="channel-skeleton" aria-hidden="true" /></p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {confirmingConnection && canManage && (
        <div className="channel-confirm" role="group" aria-label={`Disconnect ${confirmingConnection.displayName}`}>
          <p>Disconnect {confirmingConnection.displayName}? Posts that haven’t been sent will be cancelled. Videos already on YouTube stay there.</p>
          <div>
            <button ref={cancelButton} className="button secondary" disabled={working} onClick={() => closeConfirm(confirmingConnection.id)}>
              Keep connected
            </button>
            <button className="button danger" disabled={working} onClick={() => void disconnect(confirmingConnection)}>
              {busy === "disconnecting" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </div>
      )}
      {status && youtube?.availability === "ready" && youtubeConnections.length > 0 && (
        <details className="channel-note">
          <summary>How public posts reach YouTube</summary>
          <p>
            A public post is uploaded as private with its release time, and YouTube publishes it then. {youtube.note} Until then the post shows as Accepted,
            with the video’s ID.
          </p>
        </details>
      )}
    </section>
  );
}
