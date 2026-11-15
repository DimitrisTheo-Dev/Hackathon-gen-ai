import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, Instagram, Linkedin, LoaderCircle, CircleDashed, MessageCircle, Music2, Share2, Youtube, type LucideIcon } from "lucide-react";
import { Notice } from "../components/ui";
import { ApiError } from "../data/client";
import { supabase } from "../lib/supabase";
import { createSocialsApi, type SocialCatalog, type SocialProviderInfo } from "../socials/api";
import { accountSource, activity, cancelledNote, managedHere, plural } from "../socials/model";
import "../channels.css";
import "../settings.css";

/**
 * Settings: the social accounts Faceful posts to, and connecting more (Instagram by signing in, Buffer with its API
 * key). A YouTube channel is connected with Google in the Schedule view and only listed here.
 *
 * Webhooks are not something a person sets up. The engine subscribes each account to its platform's activity when it
 * connects and keeps asking until the platform agrees (socials.ts, socials-events.ts); each row only says where that
 * stands. Nothing here is "connected" unless the engine says so; every action is the engine's.
 */

const PLATFORM_ICON: Record<string, LucideIcon> = { instagram: Instagram, tiktok: Music2, youtube: Youtube, linkedin: Linkedin, whatsapp: MessageCircle };
const PROVIDER_ICON: Record<string, LucideIcon> = { instagram: Instagram, buffer: Share2 };
const PROVIDER_SUMMARY: Record<string, string> = {
  instagram: "Sign in at Instagram. Posts go out directly.",
  buffer: "Use the accounts you already have in Buffer.",
};
/** What a person types to connect a provider that takes credentials. Sent to the engine, which stores it encrypted. */
const PROVIDER_FIELD: Record<string, { name: string; label: string; hint: string; minLength: number; tooShort: string }> = {
  buffer: {
    name: "apiKey",
    label: "Buffer API key",
    hint: "Create one in Buffer under Settings → API. Faceful stores it encrypted and never shows it again.",
    // The engine refuses shorter keys (socials-buffer.ts), so this is said here, before anything is sent.
    minLength: 16,
    tooShort: "That’s shorter than a Buffer API key. Copy the whole key from Buffer (Settings → API).",
  },
};

const stateLabel = { connected: "Connected", expired: "Reconnect needed", unavailable: "Unavailable" } as const;
/**
 * The engine's messages for these actions are written for people and pass through; a transport failure gets a plain
 * sentence. So does a request its contract refuses: that message names a field and a rule, which is for developers.
 */
function failureText(failure: unknown, fallback: string) {
  if (!(failure instanceof ApiError) || !failure.message.trim()) return fallback;
  if (failure.code === "unauthenticated") return "Your sign-in ended. Sign in again to manage accounts.";
  if (failure.code === "validation_error" && failure.message.startsWith("The request does not match")) return fallback;
  return failure.message;
}

type Busy = { action: "starting" | "connecting" | "refreshing" | "removing"; id: string } | null;
type Confirming = { kind: "provider" | "account"; id: string; label: string } | null;

export function Settings({ onOpenSchedule }: { onOpenSchedule: () => void }) {
  const api = useMemo(() => createSocialsApi(import.meta.env.VITE_CASTROOM_API_URL || location.origin, async () => (await supabase?.auth.getSession())?.data.session?.access_token ?? null), []);
  const [catalog, setCatalog] = useState<SocialCatalog | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [form, setForm] = useState<{ provider: string; value: string } | null>(null);
  const alive = useRef(true);
  const keepButton = useRef<HTMLButtonElement>(null);
  const fieldInput = useRef<HTMLInputElement>(null);
  const accountsHeading = useId();
  const addHeading = useId();
  const fieldId = useId();

  const load = useCallback(async () => {
    try {
      const next = await api.catalog();
      if (!alive.current) return;
      setCatalog(next);
      setLoadFailed(false);
    } catch {
      if (alive.current) setLoadFailed(true);
    }
  }, [api]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (confirming) keepButton.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (form) fieldInput.current?.focus();
  }, [form?.provider]);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    await load();
    if (alive.current) setRetrying(false);
  }
  /** One action at a time. `work` answers with what to tell the person once it is done. */
  async function run(next: NonNullable<Busy>, fallback: string, work: () => Promise<string>) {
    if (busy) return;
    setBusy(next);
    setError("");
    setNotice("");
    try {
      const said = await work();
      if (!alive.current) return;
      setNotice(said);
      setConfirming(null);
      setForm(null);
      await load();
    } catch (failure) {
      if (alive.current) setError(failureText(failure, fallback));
    } finally {
      if (alive.current) setBusy(null);
    }
  }
  async function signIn(provider: SocialProviderInfo) {
    if (busy) return;
    setBusy({ action: "starting", id: provider.id });
    setError("");
    setNotice("");
    try {
      // The browser leaves for the platform; it comes back to /studio/connect/<provider>, which finishes the connection.
      location.assign((await api.start(provider.id)).authorizeUrl);
    } catch (failure) {
      if (!alive.current) return;
      setError(failureText(failure, `${provider.label} couldn’t be opened. Nothing was connected; try again.`));
      setBusy(null);
    }
  }
  function submitCredentials(event: FormEvent, provider: SocialProviderInfo) {
    event.preventDefault();
    const field = PROVIDER_FIELD[provider.id];
    const value = form?.value.trim() ?? "";
    if (!field || !value) return;
    if (value.length < field.minLength) {
      setNotice("");
      setError(field.tooShort);
      fieldInput.current?.focus();
      return;
    }
    void run({ action: "connecting", id: provider.id }, `${provider.label} couldn’t be connected. Nothing was saved; try again.`, async () => {
      const { accounts } = await api.connectWithCredentials(provider.id, { [field.name]: value });
      const usable = accounts.filter((account) => account.state === "connected").length;
      return usable ? `Connected ${provider.label}: ${plural(usable, "account", "accounts")} ready.` : `Connected ${provider.label}, but it has no accounts this studio can post to yet.`;
    });
  }
  const refresh = (provider: SocialProviderInfo) =>
    run({ action: "refreshing", id: provider.id }, `${provider.label} couldn’t be refreshed. Nothing changed; try again.`, async () => {
      await api.sync(provider.id);
      return `${provider.label} accounts are up to date.`;
    });
  const remove = (target: NonNullable<Confirming>) =>
    run({ action: "removing", id: target.id }, `${target.label} couldn’t be removed. Nothing changed; try again.`, async () => {
      const { cancelledPosts } = target.kind === "provider" ? await api.disconnect(target.id) : await api.removeAccount(target.id);
      return `${target.kind === "provider" ? "Disconnected" : "Removed"} ${target.label}.${cancelledNote(cancelledPosts)}`;
    });

  const providers = catalog?.providers ?? [];
  const accounts = catalog?.platforms.flatMap((platform) => platform.accounts.map((account) => ({ account, platform }))) ?? [];
  const canManage = Boolean(catalog?.canManage);
  const working = busy !== null;
  const formProvider = providers.find((provider) => provider.id === form?.provider) ?? null;
  const youtubeChannels = accounts.filter(({ account }) => account.platform === "youtube" && !managedHere(account, providers));

  return (
    <div className="settings-view">
      <header className="ob-page-head">
        <div>
          <h1>Settings</h1>
          <p>The accounts Faceful can post to. Where a platform allows it, their comments and messages connect on their own.</p>
        </div>
      </header>

      {loadFailed ? (
        <p className="channels-failed" role="alert">
          <span>Couldn’t load settings</span>
          <span aria-hidden="true">·</span>
          <button className="text-button" disabled={retrying} onClick={() => void retry()}>
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </p>
      ) : (
        <div className="settings-panel">
          <section className="channels" aria-labelledby={accountsHeading} aria-busy={working || !catalog}>
            <header className="channels-head">
              <h2 id={accountsHeading}>Connected accounts</h2>
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
            {!catalog ? (
              <p className="settings-skeleton" role="status"><span className="sr-only">Checking your accounts…</span></p>
            ) : accounts.length === 0 ? (
              <p className="settings-empty">No accounts are connected yet.</p>
            ) : (
              <ul className="settings-rows">
                {accounts.map(({ account, platform }) => {
                  const Icon = PLATFORM_ICON[account.platform] ?? Share2;
                  // A channel connected with its platform elsewhere is disconnected there, where that access is withdrawn too.
                  const removable = managedHere(account, providers);
                  const incoming = activity(account, platform);
                  return (
                    <li key={account.id}>
                      <span className="channel-icon" aria-hidden="true"><Icon size={17} /></span>
                      <div className="settings-row-body">
                        {account.profileUrl?.startsWith("https://") ? <a href={account.profileUrl} target="_blank" rel="noreferrer">{account.displayName}</a> : <strong>{account.displayName}</strong>}
                        <span>{platform.label} · {accountSource(account, providers)}</span>
                        {incoming && (
                          <span className="settings-activity" data-state={incoming.state}>
                            {incoming.state === "on" ? <Check size={12} aria-hidden="true" /> : <CircleDashed size={12} aria-hidden="true" />}
                            {incoming.label}
                          </span>
                        )}
                      </div>
                      <div className="settings-row-side">
                        <span className={`channel-chip ${account.state}`}>
                          {account.state === "connected" && <Check size={11} aria-hidden="true" />}
                          {stateLabel[account.state]}
                        </span>
                        {!removable ? (
                          <button className="text-button" onClick={onOpenSchedule}>Manage in Schedule</button>
                        ) : canManage ? (
                          <button className="text-button" aria-label={`Remove ${account.displayName}`} aria-expanded={confirming?.id === account.id} disabled={working} onClick={() => setConfirming({ kind: "account", id: account.id, label: account.displayName })}>
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {confirming && canManage && (
              <div className="channel-confirm" role="group" aria-label={`${confirming.kind === "provider" ? "Disconnect" : "Remove"} ${confirming.label}`}>
                <p>
                  {confirming.kind === "provider" ? `Disconnect ${confirming.label}? Its accounts are removed from this workspace.` : `Remove ${confirming.label}?`} Posts that haven’t been sent to
                  {confirming.kind === "provider" ? " them" : " it"} will be cancelled. Anything already posted stays where it is.
                </p>
                <div>
                  <button ref={keepButton} className="button secondary" disabled={working} onClick={() => setConfirming(null)}>
                    Keep connected
                  </button>
                  <button className="button danger" disabled={working} onClick={() => void remove(confirming)}>
                    {busy?.action === "removing" ? "Removing…" : confirming.kind === "provider" ? "Disconnect" : "Remove"}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="channels" aria-labelledby={addHeading}>
            <header className="channels-head">
              <h2 id={addHeading}>Add an account</h2>
              <p>{!catalog || canManage ? "Choose how to connect it." : "Ask a workspace owner or admin to connect accounts."}</p>
            </header>
            <ul className="channel-list">
              {(catalog ? providers : []).map((provider) => {
                const Icon = PROVIDER_ICON[provider.id] ?? Share2;
                const count = accounts.filter(({ account }) => account.provider === provider.id).length;
                const starting = busy?.action === "starting" && busy.id === provider.id;
                return (
                  <li className="channel-card" data-availability={provider.available ? "ready" : "not_configured"} data-connected={count > 0 || undefined} key={provider.id}>
                    <span className="channel-icon" aria-hidden="true"><Icon size={17} /></span>
                    <div className="channel-body">
                      <h3>{provider.label}</h3>
                      <p className="channel-meta" title={provider.available ? undefined : "This deployment has not been set up for it."}>
                        {!provider.available ? "Not set up yet" : count ? `${plural(count, "account", "accounts")} connected` : (PROVIDER_SUMMARY[provider.id] ?? "Not connected")}
                      </p>
                    </div>
                    {provider.available && canManage && (
                      <div className="channel-action">
                        {provider.connect === "sign_in" ? (
                          <button className="button secondary" aria-label={`Connect ${provider.label}`} disabled={working} onClick={() => void signIn(provider)}>
                            {starting ? `Opening ${provider.label}…` : count ? "Connect another" : "Connect"}
                          </button>
                        ) : count ? (
                          <span className="channel-row-actions">
                            <button className="text-button" aria-label={`Refresh ${provider.label} accounts`} disabled={working} onClick={() => void refresh(provider)}>
                              {busy?.action === "refreshing" && busy.id === provider.id ? "Refreshing…" : "Refresh"}
                            </button>
                            <button className="text-button" aria-label={`Disconnect ${provider.label}`} aria-expanded={confirming?.id === provider.id} disabled={working} onClick={() => setConfirming({ kind: "provider", id: provider.id, label: provider.label })}>
                              Disconnect
                            </button>
                          </span>
                        ) : (
                          <button className="button secondary" aria-label={`Connect ${provider.label}`} aria-expanded={form?.provider === provider.id} disabled={working} onClick={() => setForm({ provider: provider.id, value: "" })}>
                            Connect
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
              <li className="channel-card" data-availability={catalog ? "ready" : "loading"} data-connected={youtubeChannels.length > 0 || undefined}>
                <span className="channel-icon" aria-hidden="true"><Youtube size={17} /></span>
                <div className="channel-body">
                  <h3>YouTube</h3>
                  <p className="channel-meta">{!catalog ? <span className="channel-skeleton" aria-hidden="true" /> : youtubeChannels.length ? "Connected with Google" : "Connect with Google, in Schedule."}</p>
                </div>
                {catalog && (
                  <div className="channel-action">
                    <button className="button secondary" aria-label="Open Schedule to connect YouTube" onClick={onOpenSchedule}>Open Schedule</button>
                  </div>
                )}
              </li>
            </ul>
            {formProvider && PROVIDER_FIELD[formProvider.id] && canManage && (
              <form className="settings-form" aria-label={`Connect ${formProvider.label}`} onSubmit={(event) => submitCredentials(event, formProvider)}>
                <div className="ob-field">
                  <label htmlFor={fieldId}>{PROVIDER_FIELD[formProvider.id].label}</label>
                  <input ref={fieldInput} id={fieldId} type="password" autoComplete="off" spellCheck={false} maxLength={400} value={form?.value ?? ""} onChange={(event) => setForm({ provider: formProvider.id, value: event.target.value })} required />
                </div>
                <p className="ob-fine">{PROVIDER_FIELD[formProvider.id].hint}</p>
                <div>
                  <button className="button primary" disabled={working || !form?.value.trim()}>
                    {busy?.action === "connecting" ? <><LoaderCircle size={14} className="spin" aria-hidden="true" /> Connecting…</> : `Connect ${formProvider.label}`}
                  </button>
                  <button className="button secondary" type="button" disabled={working} onClick={() => setForm(null)}>Cancel</button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
