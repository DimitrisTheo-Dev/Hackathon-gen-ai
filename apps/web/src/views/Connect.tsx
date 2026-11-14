import { AgentIcon } from '../components/AgentIcon';
import { useRef, useState } from "react";
import {
  ArrowRight,
  Plug,
  Check,
  KeyRound,
  ExternalLink,
  FileText,
} from "lucide-react";
import type { StudioContext } from "@castroom/contracts";
import type { CreateConnectionInput, StudioClient } from "../data/client";
import { CopyButton, Notice, dateLabel } from "../components/ui";

type Host = "codex" | "claude";
type Connection = StudioContext["connections"][number];
type PendingAction = "create" | "check" | "revoke" | null;

type ConnectProps = {
  context: StudioContext;
  client: StudioClient;
  refresh: () => Promise<void>;
  onContinue: () => void;
  onCreateCampaign?: () => void;
};

const hostNames: Record<Host, string> = {
  codex: "Codex",
  claude: "Claude Code",
};
const requestedScopes = [
  "campaign:read",
  "content:edit",
  "render:write",
  "schedule:prepare",
];

function usableEndpoint(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    // Setup instructions never embed credentials, URL tokens, or shell fragments.
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isVerified(connection: Connection, now: number): boolean {
  return Boolean(
    connection.lastSeenAt &&
      !connection.revokedAt &&
      Date.parse(connection.expiresAt) > now,
  );
}

export function Connect({
  context,
  client,
  refresh,
  onContinue,
  onCreateCampaign,
}: ConnectProps) {
  const [host, setHost] = useState<Host>("codex");
  const [manual, setManual] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingAction>(null);
  const [pendingConnectionId, setPendingConnectionId] = useState<string | null>(
    null,
  );
  const [token, setToken] = useState("");
  const [issuedConnection, setIssuedConnection] = useState<Connection | null>(
    null,
  );
  const [revokedIds, setRevokedIds] = useState<Set<string>>(() => new Set());
  const createRequests = useRef<Partial<Record<Host, CreateConnectionInput>>>(
    {},
  );
  const revokeKeys = useRef<Record<string, string>>({});
  const isLive = context.capabilities.mode === "live";
  const endpoint = usableEndpoint(context.capabilities.mcpUrl);
  const canSetUp = isLive && Boolean(endpoint);
  const busy = pending !== null;
  const now = Date.now();
  const connections =
    issuedConnection &&
    !context.connections.some(
      (connection) => connection.id === issuedConnection.id,
    )
      ? [...context.connections, issuedConnection]
      : context.connections;
  const verified = isLive
    ? connections.filter(
        (connection) =>
          !revokedIds.has(connection.id) && isVerified(connection, now),
      )
    : [];
  const selectedName = hostNames[host];
  const templateUrl = endpoint ?? "REPLACE_WITH_STUDIO_PROVIDED_HTTPS_MCP_URL";
  const config =
    host === "codex"
      ? `[mcp_servers.castroom]\nurl = ${JSON.stringify(templateUrl)}\nbearer_token_env_var = "CASTROOM_TOKEN"`
      : JSON.stringify(
          {
            mcpServers: {
              castroom: {
                type: "http",
                url: endpoint ?? "${CASTROOM_MCP_URL}",
                headers: { Authorization: "Bearer ${CASTROOM_TOKEN}" },
              },
            },
          },
          null,
          2,
        );
  const command = `codex mcp add castroom --url ${shellQuote(templateUrl)} --bearer-token-env-var CASTROOM_TOKEN`;
  const showCommand = host === "codex" && !manual;
  const code = showCommand ? command : config;

  function chooseHost(next: Host) {
    if (next === host) return;
    setHost(next);
    setMessage("");
    setError("");
    // A workspace token can be used in either host; do not discard its one-time value on a tab change.
  }

  async function createConnection() {
    if (!canSetUp || !context.capabilities.canCreateAgentToken || busy || token)
      return;
    setPending("create");
    setError("");
    setMessage("");
    const request = createRequests.current[host] ?? {
      displayName: selectedName,
      scopes: [...requestedScopes],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      operationKey: crypto.randomUUID(),
    };
    createRequests.current[host] = request;
    try {
      const result = await client.createConnection(request);
      setToken(result.token);
      setIssuedConnection(result.connection);
      delete createRequests.current[host];
      setMessage(
        "Workspace token created. Store it securely, then hide it. Your agent has not connected yet.",
      );
      try {
        await refresh();
      } catch {
        setError(
          "The token was created, but the connection list could not refresh. Store this token before leaving; check the list again when the service is available.",
        );
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not create the connection. Try again with the same request.",
      );
    } finally {
      setPending(null);
    }
  }

  async function checkConnection() {
    if (!canSetUp || busy) return;
    setPending("check");
    setError("");
    setMessage("");
    try {
      const latest = await client.getContext();
      const candidates = issuedConnection
        ? latest.connections.filter(
            (connection) => connection.id === issuedConnection.id,
          )
        : latest.connections;
      const confirmed =
        latest.capabilities.mode === "live"
          ? candidates.find(
              (connection) =>
                !revokedIds.has(connection.id) &&
                isVerified(connection, Date.now()),
            )
          : undefined;
      setMessage(
        confirmed
          ? `${confirmed.displayName} connected. The server recorded an authenticated call at ${dateLabel(confirmed.lastSeenAt!, latest.workspace.timezone)}.`
          : "No active authenticated call has been recorded for this connection. Run studio_get_context from your agent, then check again.",
      );
      try {
        await refresh();
      } catch {
        setError(
          "The connection check completed, but the workspace could not refresh. Check again before continuing with agent actions.",
        );
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not check the connection. Try again when the service is available.",
      );
    } finally {
      setPending(null);
    }
  }

  async function revokeConnection(connection: Connection) {
    if (
      !isLive ||
      busy ||
      connection.revokedAt ||
      revokedIds.has(connection.id)
    )
      return;
    setPending("revoke");
    setPendingConnectionId(connection.id);
    setError("");
    setMessage("");
    const operationKey =
      revokeKeys.current[connection.id] ?? crypto.randomUUID();
    revokeKeys.current[connection.id] = operationKey;
    try {
      await client.revokeConnection({
        connectionId: connection.id,
        operationKey,
      });
      setRevokedIds((current) => new Set([...current, connection.id]));
      delete revokeKeys.current[connection.id];
      if (issuedConnection?.id === connection.id) setToken("");
      setMessage(
        `${connection.displayName} was revoked. Already authorized jobs and accepted schedules require separate cancellation.`,
      );
      try {
        await refresh();
      } catch {
        setError(
          "Revocation succeeded, but the workspace could not refresh. Reload when the service is available to see the updated list.",
        );
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Revocation could not be confirmed. Check the connection before retrying.",
      );
    } finally {
      setPending(null);
      setPendingConnectionId(null);
    }
  }

  return (
    <div className="connect-view">
      <div className="connect-intro">
        <span className="connect-symbol" aria-hidden="true">
          <Plug size={26} />
        </span>
        <h1>Connect your agent</h1>
        <p>
          Create campaigns with your agent.
          <br />
          Fine-tune them here.
        </p>
      </div>

      <div className="host-choices" role="group" aria-label="Choose your agent">
        <button
          type="button"
          aria-pressed={host === "codex"}
          aria-controls="agent-setup"
          onClick={() => chooseHost("codex")}
          disabled={busy}
        >
          <span className="host-logo" aria-hidden="true">
            <AgentIcon host="codex" size={32} />
          </span>
          <strong>Codex</strong>
          <small>Terminal client</small>
        </button>
        <button
          type="button"
          aria-pressed={host === "claude"}
          aria-controls="agent-setup"
          onClick={() => chooseHost("claude")}
          disabled={busy}
        >
          <span className="host-logo claude-logo" aria-hidden="true">
            <AgentIcon host="claude" size={32} />
          </span>
          <strong>Claude Code</strong>
          <small>Terminal client</small>
        </button>
      </div>

      <section
        className="setup-card"
        id="agent-setup"
        aria-labelledby="setup-title"
      >
        <div className="setup-heading">
          <h2 id="setup-title">Set up {selectedName}</h2>
          <button
            type="button"
            className="text-button"
            aria-pressed={manual}
            onClick={() => setManual((current) => !current)}
          >
            {manual ? "Guided setup" : "Manual configuration"}
          </button>
        </div>
        <p className="setup-workspace">
          Workspace <strong>{context.workspace.name}</strong>
        </p>

        {!canSetUp && (
          <Notice>
            {isLive
              ? "Agent setup is not available in this workspace yet."
              : "Agent setup is not connected to this workspace yet."}{" "}
            You can continue in the studio while agent setup is unavailable.
          </Notice>
        )}

        {canSetUp ? (
          <>
            <p className="muted">
              Request access to read campaigns, edit drafts, render, and prepare
              a schedule for up to 24 hours. Publication still needs a separate
              review or owner-created campaign grant.
            </p>
            <ol className="setup-steps">
              <li>
                <strong>Create a workspace token</strong>
                <p>
                  Store it in your local <code>CASTROOM_TOKEN</code> environment
                  variable before launching {selectedName}. Keep it out of
                  prompts, URLs, recordings, and git.
                </p>
                <button
                  type="button"
                  className="button secondary"
                  disabled={
                    !context.capabilities.canCreateAgentToken ||
                    busy ||
                    Boolean(token)
                  }
                  onClick={() => void createConnection()}
                >
                  <KeyRound size={15} aria-hidden="true" />
                  {pending === "create"
                    ? "Creating token…"
                    : "Create workspace token"}
                </button>
                {!context.capabilities.canCreateAgentToken && (
                  <p>
                    Token creation is not enabled for this workspace or your
                    current access.
                  </p>
                )}
                {token && issuedConnection && (
                  <div className="token-once">
                    <label htmlFor="new-token">
                      {issuedConnection.displayName} token · available only in
                      this session
                    </label>
                    <input
                      id="new-token"
                      type="password"
                      readOnly
                      value={token}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <CopyButton
                      key={issuedConnection.id}
                      value={token}
                      label="Copy token"
                    />
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setToken("")}
                    >
                      Hide token
                    </button>
                    <p>
                      Expires{" "}
                      {dateLabel(
                        issuedConnection.expiresAt,
                        context.workspace.timezone,
                      )}
                      . Granted scopes: {issuedConnection.scopes.join(", ")}.
                    </p>
                  </div>
                )}
              </li>
              <li>
                <strong>
                  {showCommand
                    ? "Add Faceful in your terminal"
                    : host === "codex"
                      ? "Merge this into your Codex config.toml"
                      : "Merge this into your project’s .mcp.json"}
                </strong>
                {!showCommand && (
                  <p>
                    Keep existing server entries. The configuration references
                    your token; it never contains the token itself.
                  </p>
                )}
                <pre
                  tabIndex={0}
                  aria-label={`${selectedName} ${showCommand ? "setup command" : "configuration"}`}
                >
                  <code>{code}</code>
                </pre>
                <CopyButton
                  key={`${host}-${manual}`}
                  value={code}
                  label={
                    showCommand ? "Copy setup command" : "Copy configuration"
                  }
                />
                {host === "claude" && (
                  <p>
                    Open Claude Code from the configured environment, review the
                    trusted project’s server prompt, then open <code>/mcp</code>
                    .
                  </p>
                )}
              </li>
              <li>
                <strong>Check your first authenticated call</strong>
                <p>
                  Ask your agent: “Use <code>studio_get_context</code> to show
                  my workspace, avatars, and available actions.” Then check for
                  the server’s confirmation here.
                </p>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => void checkConnection()}
                >
                  <Plug size={15} aria-hidden="true" />
                  {pending === "check"
                    ? "Checking connection…"
                    : "Check connection"}
                </button>
              </li>
            </ol>
          </>
        ) : (
          manual && (
            <div className="setup-steps">
              <p className="muted">
                Template only. The live endpoint and a scoped workspace token
                are required before this configuration can work.
              </p>
              <pre
                tabIndex={0}
                aria-label={`${selectedName} configuration template`}
              >
                <code>{config}</code>
              </pre>
            </div>
          )
        )}

        {message && (
          <div role="status" aria-live="polite">
            <Notice>{message}</Notice>
          </div>
        )}
        {error && <Notice error>{error}</Notice>}
        <p className="small muted">
          A copied command does not establish a connection. Authenticated client
          trials are pending; other MCP hosts have not been tested.
        </p>
        <a
          className="text-button"
          href="/docs/setup/"
          target="_blank"
          rel="noreferrer"
        >
          Open setup instructions <ExternalLink size={13} aria-hidden="true" />
        </a>
      </section>

      {connections.length > 0 && (
        <section
          className="connections-list"
          aria-labelledby="connections-title"
        >
          <h2 id="connections-title">
            Workspace connections <span>{verified.length} verified</span>
          </h2>
          {connections.map((connection) => {
            const revoked = Boolean(
              connection.revokedAt || revokedIds.has(connection.id),
            );
            const expired = Date.parse(connection.expiresAt) <= now;
            const confirmed = isLive && !revoked && isVerified(connection, now);
            const state = !isLive
              ? "Example request"
              : revoked
                ? "Revoked"
                : expired
                  ? "Expired"
                  : confirmed
                    ? "Connected"
                    : "Awaiting first authenticated call";
            return (
              <article key={connection.id}>
                <div>
                  <strong>{connection.displayName}</strong>
                  <p>
                    {confirmed && <Check size={12} aria-hidden="true" />}{" "}
                    {state}
                  </p>
                  {isLive && connection.lastSeenAt && (
                    <p>
                      Last authenticated call{" "}
                      {dateLabel(
                        connection.lastSeenAt,
                        context.workspace.timezone,
                      )}
                    </p>
                  )}
                  <small>
                    {connection.scopes.join(", ")} · Expires{" "}
                    {dateLabel(
                      connection.expiresAt,
                      context.workspace.timezone,
                    )}
                  </small>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  disabled={!isLive || revoked || busy}
                  onClick={() => void revokeConnection(connection)}
                >
                  {pending === "revoke" && pendingConnectionId === connection.id
                    ? "Revoking…"
                    : "Revoke"}
                </button>
              </article>
            );
          })}
          <p>
            Revoking a token blocks new calls. Cancel already authorized work or
            accepted schedules separately.
          </p>
        </section>
      )}

      <div className="connect-footer onboarding-next">
        {onCreateCampaign && (
          <button
            type="button"
            className="button primary"
            onClick={onCreateCampaign}
          >
            <FileText size={15} aria-hidden="true" />
            Add a company brief
          </button>
        )}
        <button type="button" className="text-button" onClick={onContinue}>
          Continue in studio <ArrowRight size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
