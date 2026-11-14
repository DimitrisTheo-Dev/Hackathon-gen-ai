import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CodeXml, Eye, EyeOff, KeyRound, LoaderCircle, MousePointer2, Plug, ShieldCheck, Sparkle } from "lucide-react";
import type { StudioContext } from "@castroom/contracts";
import type { CreateConnectionInput, StudioClient } from "../data/client";
import { AgentIcon } from "../components/AgentIcon";
import { CopyAction, Segmented, Step, relativeTime } from "./onboarding-parts";

type AgentId = "claude" | "codex" | "cursor" | "gemini" | "vscode" | "generic";
type Mode = "quick" | "manual";
type Connection = StudioContext["connections"][number];

type ConnectProps = {
  context: StudioContext;
  client: StudioClient;
  refresh: () => Promise<void>;
  onContinue: () => void;
  onCreateCampaign?: () => void;
};

/** Only the two agents that completed a recorded session against this server are called "Tested". */
const AGENTS: Array<{ id: AgentId; name: string; where: string; tested: boolean }> = [
  { id: "claude", name: "Claude Code", where: "Terminal", tested: true },
  { id: "codex", name: "Codex", where: "Terminal", tested: true },
  { id: "cursor", name: "Cursor", where: "Editor", tested: false },
  { id: "gemini", name: "Gemini CLI", where: "Terminal", tested: false },
  { id: "vscode", name: "VS Code", where: "Editor", tested: false },
  { id: "generic", name: "Any MCP client", where: "Remote MCP", tested: false },
];
/** What a workspace token may do. Approval, billing management and token administration stay with people. */
const TOKEN_SCOPES = ["campaign:read", "content:edit", "render:write", "schedule:prepare", "billing:read"];
const TOKEN_DAYS = 30;
const scopeNames: Record<string, string> = {
  "campaign:read": "Read projects",
  "content:edit": "Edit drafts",
  "render:write": "Request renders",
  "schedule:prepare": "Prepare schedules",
  "billing:read": "See credits",
  "billing:checkout": "Open checkout",
};

function usableEndpoint(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    // Setup instructions never embed credentials, URL tokens or shell fragments.
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const isActive = (connection: Connection, now: number) => !connection.revokedAt && Date.parse(connection.expiresAt) > now;

function AgentTile({ id, size = 44 }: { id: AgentId; size?: number }) {
  const glyph = Math.round(size * 0.5);
  return (
    <span className="ob-agent-tile" data-agent={id} style={{ inlineSize: size, blockSize: size }} aria-hidden="true">
      {id === "claude" || id === "codex" ? (
        <AgentIcon host={id} size={Math.round(size * 0.62)} />
      ) : id === "cursor" ? (
        <MousePointer2 size={glyph} strokeWidth={1.75} />
      ) : id === "gemini" ? (
        <Sparkle size={glyph} strokeWidth={1.75} />
      ) : id === "vscode" ? (
        <CodeXml size={glyph} strokeWidth={1.75} />
      ) : (
        <Plug size={glyph} strokeWidth={1.75} />
      )}
    </span>
  );
}

interface Snippet {
  title: string;
  note: string;
  label: string;
  /** What is shown. A token never appears here. */
  shown: string;
  /** What is copied. Includes the token only while it is still held from this session's one-time reveal. */
  copied: string;
  includesToken: boolean;
}
function snippetFor(agent: AgentId, mode: Mode, url: string, token: string): Snippet {
  const exported = (value: string) => `export FACEFUL_TOKEN=${value}`;
  const tokenShown = exported(token ? "'••••••••••••'" : "'paste-your-token'");
  const tokenCopied = exported(token ? shellQuote(token) : "'paste-your-token'");
  const withToken = (command: string): Pick<Snippet, "shown" | "copied" | "includesToken"> => ({ shown: `${tokenShown}\n${command}`, copied: `${tokenCopied}\n${command}`, includesToken: Boolean(token) });
  if (agent === "claude") {
    if (mode === "quick")
      return { title: "Add Faceful to Claude Code", note: "Run this in the terminal where you use Claude Code.", label: "Claude Code setup command", ...withToken(`claude mcp add --transport http faceful ${url} --header "Authorization: Bearer $FACEFUL_TOKEN"`) };
    const config = JSON.stringify({ mcpServers: { faceful: { type: "http", url, headers: { Authorization: "Bearer ${FACEFUL_TOKEN}" } } } }, null, 2);
    return { title: "Add Faceful to your project’s .mcp.json", note: "Keep your other servers. The file refers to FACEFUL_TOKEN; it never contains the token.", label: "Claude Code .mcp.json entry", shown: config, copied: config, includesToken: false };
  }
  if (agent === "codex") {
    if (mode === "quick")
      return { title: "Add Faceful to Codex", note: "Run this in the terminal where you use Codex.", label: "Codex setup command", ...withToken(`codex mcp add faceful --url ${url} --bearer-token-env-var FACEFUL_TOKEN`) };
    const config = `[mcp_servers.faceful]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "FACEFUL_TOKEN"`;
    return { title: "Add Faceful to ~/.codex/config.toml", note: "Keep your other servers. Codex reads the token from FACEFUL_TOKEN when it starts.", label: "Codex config.toml entry", shown: config, copied: config, includesToken: false };
  }
  if (mode === "quick") {
    const config = JSON.stringify({ mcpServers: { faceful: { url, headers: { Authorization: "Bearer ${FACEFUL_TOKEN}" } } } }, null, 2);
    return {
      title: "Add the standard MCP configuration",
      note: "Paste this where your client keeps its MCP servers. If it doesn’t read environment variables, put the token in place of ${FACEFUL_TOKEN} and keep that file out of git.",
      label: "Standard MCP configuration",
      shown: config,
      copied: config,
      includesToken: false,
    };
  }
  const details = `Server URL   ${url}\nTransport    Streamable HTTP\nHeader       Authorization: Bearer <your token>`;
  return { title: "Enter the connection details", note: "Use these three values in your client’s “add remote MCP server” form.", label: "Connection details", shown: details, copied: details, includesToken: false };
}

export function Connect({ context, client, refresh, onContinue }: ConnectProps) {
  const [picked, setPicked] = useState<AgentId | null>(null);
  const [mode, setMode] = useState<Mode>("quick");
  const [pending, setPending] = useState<"create" | "revoke" | null>(null);
  const [error, setError] = useState("");
  const [token, setToken] = useState("");
  const [reveal, setReveal] = useState(false);
  const [issued, setIssued] = useState<Connection | null>(null);
  const [copiedSetup, setCopiedSetup] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokedIds, setRevokedIds] = useState<Set<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const createRequest = useRef<CreateConnectionInput | null>(null);
  const revokeKeys = useRef<Record<string, string>>({});
  const heading = useRef<HTMLHeadingElement>(null);
  const cards = useRef<Partial<Record<AgentId, HTMLButtonElement | null>>>({});
  // What each connection looked like when this view opened; anything newer is a call made since.
  const seenAtOpen = useRef<Map<string, string | null>>(new Map(context.connections.map((connection) => [connection.id, connection.lastSeenAt])));

  const isLive = context.capabilities.mode === "live";
  const endpoint = usableEndpoint(context.capabilities.mcpUrl);
  const canSetUp = isLive && Boolean(endpoint);
  const canCreate = canSetUp && context.capabilities.canCreateAgentToken;
  const url = endpoint ?? "https://your-faceful-site/mcp";
  const agent = AGENTS.find((entry) => entry.id === picked) ?? null;

  const connections = useMemo(() => {
    const list = issued && !context.connections.some((connection) => connection.id === issued.id) ? [issued, ...context.connections] : context.connections;
    return list.map((connection) => (revokedIds.has(connection.id) && !connection.revokedAt ? { ...connection, revokedAt: new Date(now).toISOString() } : connection));
  }, [context.connections, issued, revokedIds, now]);
  const active = connections.filter((connection) => isActive(connection, now));
  const past = connections.filter((connection) => !isActive(connection, now));
  const isNewCall = (connection: Connection) => Boolean(connection.lastSeenAt) && seenAtOpen.current.get(connection.id) !== connection.lastSeenAt;
  // The connection this visit is about: the token just created, else whichever answered since the view opened.
  const watched = (issued && active.find((connection) => connection.id === issued.id)) || active.find(isNewCall) || null;
  const connected = Boolean(watched && isNewCall(watched));

  // Live confirmation: ask the server every few seconds while this view is on screen, and stop when it is not.
  useEffect(() => {
    if (!isLive) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      void refresh().catch(() => undefined);
    };
    const timer = window.setInterval(tick, 4000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [isLive, refresh]);
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connected && !wasConnected.current && watched) setAnnouncement(`${watched.displayName} is connected.`);
    wasConnected.current = connected;
  }, [connected, watched]);

  function choose(id: AgentId) {
    setPicked(id);
    setMode("quick");
    setError("");
    setCopiedSetup(false);
    createRequest.current = null;
    // A workspace token works in any agent; its one-time value is kept while this view stays open.
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }
  function back() {
    const previous = picked;
    setPicked(null);
    setError("");
    requestAnimationFrame(() => (previous ? cards.current[previous]?.focus({ preventScroll: true }) : undefined));
  }

  async function createToken() {
    if (!canCreate || pending || !agent) return;
    setPending("create");
    setError("");
    // The same request is reused if this attempt has to be retried.
    createRequest.current ??= {
      displayName: agent.name,
      scopes: [...TOKEN_SCOPES],
      expiresAt: new Date(Date.now() + TOKEN_DAYS * 24 * 3600_000).toISOString(),
      operationKey: crypto.randomUUID(),
    };
    try {
      const result = await client.createConnection(createRequest.current);
      createRequest.current = null;
      setToken(result.token);
      setReveal(false);
      setIssued(result.connection);
      setCopiedSetup(false);
      setAnnouncement("Token created. Copy it now; it is shown only once.");
      await refresh().catch(() => undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The token could not be created. Try again.");
    } finally {
      setPending(null);
    }
  }

  async function revoke(connection: Connection) {
    if (!isLive || pending) return;
    setPending("revoke");
    setRevoking(connection.id);
    setError("");
    const operationKey = (revokeKeys.current[connection.id] ??= crypto.randomUUID());
    try {
      await client.revokeConnection({ connectionId: connection.id, operationKey });
      delete revokeKeys.current[connection.id];
      setRevokedIds((current) => new Set([...current, connection.id]));
      if (issued?.id === connection.id) setToken("");
      setConfirmRevoke(null);
      setAnnouncement(`${connection.displayName} token revoked. New calls with it are refused.`);
      await refresh().catch(() => undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The token could not be revoked. Check the list before trying again.");
    } finally {
      setPending(null);
      setRevoking(null);
    }
  }

  const snippet = agent ? snippetFor(agent.id, mode, url, token) : null;
  const hasToken = Boolean(token) || active.length > 0;
  const stepOne = hasToken ? "done" : "current";
  const stepTwo = connected || copiedSetup ? "done" : hasToken ? "current" : "todo";
  const stepThree = connected ? "done" : hasToken && (copiedSetup || Boolean(issued)) ? "current" : "todo";
  const unavailable = !isLive
    ? "This is the local preview. Agent connections work in the live studio."
    : !endpoint
      ? "Agent connections aren’t switched on for this deployment yet. You can keep working in the studio."
      : !context.capabilities.canCreateAgentToken
        ? "Only a workspace owner or admin can create tokens. Ask one to create it for you."
        : "";

  return (
    <div className="ob-connect" data-view={agent ? "steps" : "grid"}>
      {!agent ? (
        <div className="ob-connect-pane" key="grid">
          <header className="ob-connect-hero">
            <div className="ob-agent-stack" aria-hidden="true">
              {(["claude", "codex", "cursor", "gemini", "vscode"] as AgentId[]).map((id, index) => (
                <span key={id} style={{ "--ob-i": index } as React.CSSProperties}><AgentTile id={id} size={56} /></span>
              ))}
            </div>
            <h1>Connect your agent</h1>
            <p>Faceful works inside the agent you already use. Same projects, same rules as the studio.</p>
          </header>

          <section aria-labelledby="ob-agents-title">
            <h2 className="ob-section-title" id="ob-agents-title">Choose your agent</h2>
            <ul className="ob-agent-grid">
              {AGENTS.map((entry, index) => (
                <li key={entry.id} style={{ "--ob-i": index } as React.CSSProperties}>
                  <button type="button" className="ob-agent-card" ref={(node) => { cards.current[entry.id] = node; }} onClick={() => choose(entry.id)}>
                    <AgentTile id={entry.id} />
                    <strong>{entry.name}</strong>
                    <small>{entry.where}</small>
                    {entry.tested ? <span className="ob-badge ob-badge-tested"><Check size={11} strokeWidth={2.5} aria-hidden="true" />Tested</span> : <span className="ob-badge">Standard MCP</span>}
                  </button>
                </li>
              ))}
            </ul>
            <p className="ob-footnote">Tested with Claude Code and Codex. The others use the same standard MCP connection and are not yet verified by us.</p>
          </section>
        </div>
      ) : (
        <div className="ob-connect-pane" key={agent.id}>
          <button type="button" className="ob-back" onClick={back}><ArrowLeft size={15} aria-hidden="true" />All agents</button>
          <header className="ob-setup-head">
            <AgentTile id={agent.id} size={48} />
            <div>
              <h1 ref={heading} tabIndex={-1}>Connect {agent.name}</h1>
              <p>{agent.tested ? "Tested with this server." : "Standard MCP configuration. Not yet verified by us with this client."} Workspace <strong>{context.workspace.name}</strong>.</p>
            </div>
          </header>

          {unavailable && <p className="ob-callout" role="note">{unavailable}</p>}

          <Segmented label="Setup style" value={mode} onChange={(next) => { setMode(next); setCopiedSetup(false); }} options={[{ value: "quick", label: "Quick setup" }, { value: "manual", label: "Do it yourself" }]} />

          <ol className="ob-steps">
            <Step number={1} title="Create a workspace token" state={stepOne}>
              {token && issued ? (
                <div className="ob-token">
                  <label htmlFor="ob-token-value">Your token · shown once</label>
                  <div className="ob-token-row">
                    <input id="ob-token-value" type={reveal ? "text" : "password"} readOnly value={token} autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
                    <button type="button" className="ob-icon-button" aria-pressed={reveal} aria-label={reveal ? "Hide token" : "Show token"} onClick={() => setReveal((current) => !current)}>
                      {reveal ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                    </button>
                    <CopyAction value={token} label="Copy token" copiedLabel="Token copied" />
                  </div>
                  <p className="ob-step-note"><ShieldCheck size={14} aria-hidden="true" />Scoped to this workspace, expires {relativeTime(issued.expiresAt, now)}, revocable any time. It can’t approve posts or manage billing.</p>
                  <button type="button" className="ob-link" onClick={() => { setToken(""); setReveal(false); }}>I’ve saved it — hide it for good</button>
                </div>
              ) : (
                <>
                  <p className="ob-step-note">
                    {active.length
                      ? `This workspace has ${active.length === 1 ? "an active token" : `${active.length} active tokens`}. A token is shown only once, so create a new one if you no longer have it.`
                      : `A key your agent uses instead of your password. Scoped to this workspace, expires after ${TOKEN_DAYS} days, revocable any time.`}
                  </p>
                  <button type="button" className={`ob-button ${active.length ? "ob-button-quiet" : "ob-button-primary"}`} disabled={!canCreate || pending !== null} onClick={() => void createToken()}>
                    {pending === "create" ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
                    {pending === "create" ? "Creating token…" : active.length ? "Create another token" : "Create token"}
                  </button>
                </>
              )}
            </Step>

            <Step number={2} title={snippet!.title} state={stepTwo}>
              <p className="ob-step-note">{snippet!.note}</p>
              <div className="ob-code-block">
                <pre tabIndex={0} aria-label={snippet!.label}><code>{snippet!.shown}</code></pre>
                <CopyAction
                  className="ob-copy-floating"
                  value={snippet!.copied}
                  label={snippet!.includesToken ? "Copy with token" : "Copy"}
                  copiedLabel="Copied"
                  onCopied={() => setCopiedSetup(true)}
                />
              </div>
              {snippet!.includesToken && <p className="ob-step-note">The copy includes your token so you can paste once. It is hidden here on purpose.</p>}
              {!snippet!.includesToken && mode === "quick" && (agent.id === "claude" || agent.id === "codex") && <p className="ob-step-note">Replace <code>paste-your-token</code> with your token before running it.</p>}
              {agent.id === "claude" && mode === "manual" && <p className="ob-step-note">Start Claude Code from a shell where <code>FACEFUL_TOKEN</code> is set, then open <code>/mcp</code> to confirm the server.</p>}
            </Step>

            <Step number={3} title={<>Ask your agent: “List my Faceful projects”</>} state={stepThree}>
              <p className="ob-live" data-state={connected ? "connected" : "waiting"}>
                {connected && watched ? (
                  <><span className="ob-live-tick" aria-hidden="true"><Check size={13} strokeWidth={2.75} /></span>Connected · last seen {relativeTime(watched.lastSeenAt!, now)}</>
                ) : (
                  <><span className="ob-live-dot" aria-hidden="true" />{hasToken ? "Waiting for your agent’s first call. This updates by itself." : "Create a token first; the confirmation appears here."}</>
                )}
              </p>
              {connected && <p className="ob-step-note">Your agent now sees the same projects you do. Try “Create a 15-second draft about …” or “How many render credits do I have?”</p>}
            </Step>
          </ol>

          <p className="ob-oauth-line">Or let your agent sign in: clients that support OAuth open Faceful’s consent screen instead of using a token. Add <code>{url}</code> as a remote MCP server with no header and approve the request when it appears.</p>
        </div>
      )}

      {error && <p className="ob-error" role="alert">{error}</p>}
      <p className="sr-only" role="status">{announcement}</p>

      {connections.length > 0 && (
        <section className="ob-connections" aria-labelledby="ob-connections-title">
          <h2 id="ob-connections-title">Your connections</h2>
          <ul>
            {active.map((connection) => {
              const fresh = isNewCall(connection);
              return (
                <li key={connection.id} data-fresh={fresh || undefined}>
                  <div className="ob-connection-main">
                    <strong>{connection.displayName}</strong>
                    <span className="ob-connection-state" data-state={connection.lastSeenAt ? "seen" : "idle"}>
                      {connection.lastSeenAt ? <>Last seen {relativeTime(connection.lastSeenAt, now)}</> : "No calls yet"}
                    </span>
                    <span className="ob-connection-meta">Expires {relativeTime(connection.expiresAt, now)}</span>
                    <ul className="ob-scope-list" aria-label="Permissions">
                      {connection.scopes.map((scope) => <li key={scope}>{scopeNames[scope] ?? scope}</li>)}
                    </ul>
                  </div>
                  {confirmRevoke === connection.id ? (
                    <div className="ob-confirm" role="group" aria-label={`Revoke the ${connection.displayName} token?`}>
                      <p>Revoke this token? {connection.displayName} stops working at once. Work it already started is not cancelled.</p>
                      <button type="button" className="ob-button ob-button-danger" disabled={pending !== null} onClick={() => void revoke(connection)}>{revoking === connection.id ? "Revoking…" : "Revoke token"}</button>
                      <button type="button" className="ob-button ob-button-quiet" disabled={pending !== null} onClick={() => setConfirmRevoke(null)}>Keep token</button>
                    </div>
                  ) : (
                    <button type="button" className="ob-link ob-link-danger" disabled={!isLive || pending !== null} aria-label={`Revoke the ${connection.displayName} token`} onClick={() => setConfirmRevoke(connection.id)}>Revoke</button>
                  )}
                </li>
              );
            })}
          </ul>
          {past.length > 0 && (
            <details className="ob-past">
              <summary>{past.length} revoked or expired</summary>
              <ul>
                {past.map((connection) => (
                  <li key={connection.id}>
                    <div className="ob-connection-main">
                      <strong>{connection.displayName}</strong>
                      <span className="ob-connection-meta">{connection.revokedAt ? "Revoked" : "Expired"}{connection.lastSeenAt ? ` · last seen ${relativeTime(connection.lastSeenAt, now)}` : ""}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      <footer className="ob-connect-foot">
        <a className="ob-link" href="/docs/mcp/" target="_blank" rel="noreferrer">How agent connections work</a>
        <button type="button" className="ob-link" onClick={onContinue}>Back to the studio <ArrowRight size={14} aria-hidden="true" /></button>
      </footer>
    </div>
  );
}
