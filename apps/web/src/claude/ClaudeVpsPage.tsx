import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Check, CircleCheck, CircleX, ExternalLink, LoaderCircle, Plus, RefreshCw, Server, Square, SquareTerminal, Wrench } from "lucide-react";
import { AgentIcon } from "../components/AgentIcon";
import { Mark, Notice } from "../components/ui";
import { createRunnerClient, normalizeRunnerUrl, RunnerError, type Model, type PermissionMode, type RunnerStatus } from "./runner";
import { addNotice, addUserPrompt, applyEvent, emptyTranscript, type Transcript, type TranscriptItem } from "./transcript";
import "./claude.css";

const STORE = "faceful.claudeRunner";
type Connection = { url: string; key: string };

function loadConnection(): Connection | null {
  try {
    const url = localStorage.getItem(`${STORE}.url`);
    const key = sessionStorage.getItem(`${STORE}.key`) ?? localStorage.getItem(`${STORE}.key`);
    return url && key ? { url, key } : null;
  } catch { return null; }
}
function saveConnection(connection: Connection | null, remember = false) {
  try {
    localStorage.removeItem(`${STORE}.key`);
    sessionStorage.removeItem(`${STORE}.key`);
    if (!connection) return;
    localStorage.setItem(`${STORE}.url`, connection.url);
    (remember ? localStorage : sessionStorage).setItem(`${STORE}.key`, connection.key);
  } catch { /* storage unavailable: the connection lasts for this visit only */ }
}
const savedUrl = () => { try { return localStorage.getItem(`${STORE}.url`) ?? ""; } catch { return ""; } };
const problem = (error: unknown) => (error instanceof RunnerError ? error.message : "Something went wrong. Try again.");

const MODELS: { value: "" | Model; label: string }[] = [
  { value: "", label: "Default model" },
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
const MODES: { value: PermissionMode; label: string; help: string }[] = [
  { value: "acceptEdits", label: "Accept edits", help: "Edits files in the workspace. Commands that need approval are skipped." },
  { value: "auto", label: "Auto", help: "Claude decides which actions are safe to run without asking." },
  { value: "bypassPermissions", label: "Full access", help: "Runs any command inside the server container without asking." },
  { value: "plan", label: "Plan only", help: "Reads and plans. Changes nothing." },
];

export default function ClaudeVpsPage() {
  const [connection, setConnection] = useState<Connection | null>(loadConnection);
  const client = useMemo(() => (connection ? createRunnerClient(connection.url, connection.key) : null), [connection]);
  const [status, setStatus] = useState<RunnerStatus | null>(null);
  const [busy, setBusy] = useState<null | "connect" | "refresh" | "login" | "finish" | "token" | "signout">(null);
  const [serverError, setServerError] = useState("");
  const [authError, setAuthError] = useState("");
  const [urlInput, setUrlInput] = useState(savedUrl);
  const [keyInput, setKeyInput] = useState("");
  const [remember, setRemember] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [model, setModel] = useState<"" | Model>("");
  const [mode, setMode] = useState<PermissionMode>("acceptEdits");
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);

  const signedIn = status?.auth.loggedIn === true;
  const ready = Boolean(client && status && signedIn);

  async function refresh(target = client) {
    if (!target) return;
    setBusy("refresh"); setServerError("");
    try { setStatus(await target.status()); }
    catch (error) {
      setServerError(problem(error));
      if (error instanceof RunnerError && error.status === 401) { saveConnection(null); setConnection(null); setStatus(null); }
    } finally { setBusy(null); }
  }
  useEffect(() => { document.title = "Claude Code on your server · Faceful"; }, []);
  useEffect(() => { if (client) void refresh(client); }, [client]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const list = listRef.current;
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 160) list.scrollTop = list.scrollHeight;
  }, [transcript]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setServerError("");
    let url: string;
    try { url = normalizeRunnerUrl(urlInput); } catch (error) { setServerError(problem(error)); return; }
    const key = keyInput.trim();
    if (!key) { setServerError("Paste the access key from the runner's .env file."); return; }
    setBusy("connect");
    try {
      const candidate = createRunnerClient(url, key);
      const next = await candidate.status();
      saveConnection({ url, key }, remember);
      setStatus(next); setKeyInput(""); setConnection({ url, key });
    } catch (error) { setServerError(problem(error)); }
    finally { setBusy(null); }
  }
  function forget() {
    if (running) return;
    saveConnection(null); setConnection(null); setStatus(null); setLoginUrl(null); setServerError(""); setAuthError("");
  }

  async function startLogin() {
    if (!client || busy) return;
    setBusy("login"); setAuthError(""); setCode("");
    try { setLoginUrl((await client.startLogin()).url); }
    catch (error) { setAuthError(problem(error)); }
    finally { setBusy(null); }
  }
  async function finishLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || busy || !code.trim()) return;
    setBusy("finish"); setAuthError("");
    try { await client.finishLogin(code.trim()); setLoginUrl(null); setCode(""); setStatus(await client.status()); }
    catch (error) { setAuthError(problem(error)); if (error instanceof RunnerError && error.code === "login_not_started") setLoginUrl(null); }
    finally { setBusy(null); }
  }
  async function cancelLogin() {
    setLoginUrl(null); setCode(""); setAuthError("");
    try { await client?.cancelLogin(); } catch { /* the runner expires it anyway */ }
  }
  async function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || busy || !token.trim()) return;
    setBusy("token"); setAuthError("");
    try { await client.saveToken(token.trim()); setToken(""); setStatus(await client.status()); }
    catch (error) { setAuthError(problem(error)); }
    finally { setBusy(null); }
  }
  async function signOut() {
    if (!client || busy || running) return;
    setBusy("signout"); setAuthError("");
    try { await client.signOut(); setStatus(await client.status()); }
    catch (error) { setAuthError(problem(error)); }
    finally { setBusy(null); }
  }

  async function send(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = prompt.trim();
    if (!client || !ready || running || !text) return;
    setPrompt("");
    setTranscript((current) => addUserPrompt(current, text));
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await client.run({ prompt: text, sessionId: transcript.sessionId ?? undefined, model: model || undefined, permissionMode: mode }, (streamed) => setTranscript((current) => applyEvent(current, streamed)), controller.signal);
    } catch (error) {
      if ((error as Error)?.name === "AbortError") setTranscript((current) => addNotice(current, "Run stopped.", false));
      else setTranscript((current) => addNotice(current, problem(error)));
    } finally {
      setRunning(false); abortRef.current = null;
    }
  }
  async function stop() {
    try { await client?.stop(); } catch { abortRef.current?.abort(); }
  }
  function onPromptKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
  }

  const modeHelp = MODES.find((item) => item.value === mode)?.help;
  return (
    <div className="cc-page">
      <header className="cc-header">
        <a className="wordmark" href="/"><Mark />Faceful</a>
        <span className="cc-header-title">Claude Code on your server</span>
      </header>
      <main className="cc-layout">
        <div className="cc-setup">
          <section className="cc-card" aria-labelledby="cc-server-title">
            <div className="cc-card-head">
              <span className="cc-step"><Server size={16} aria-hidden="true" /></span>
              <h2 id="cc-server-title">{connection ? "Server" : "Connect your server"}</h2>
              {connection && status && <span className="cc-chip positive"><Check size={13} aria-hidden="true" />Connected</span>}
            </div>
            {connection ? <>
              <dl className="cc-facts">
                <div><dt>Address</dt><dd>{connection.url}</dd></div>
                <div><dt>Claude Code</dt><dd>{status ? status.claudeVersion ?? "Not found on the server" : busy === "refresh" ? "Checking…" : "Unknown"}</dd></div>
                <div><dt>Workspace</dt><dd>{status?.workspace ?? "…"}</dd></div>
              </dl>
              <div className="cc-row">
                <button className="text-button" type="button" onClick={() => void refresh()} disabled={busy !== null}><RefreshCw size={13} aria-hidden="true" />{busy === "refresh" ? "Checking…" : "Check again"}</button>
                <button className="text-button" type="button" onClick={forget} disabled={running}>Forget server</button>
              </div>
            </> : <>
              <p>The runner on your VPS runs the official Claude Code CLI. Paste its address and the access key from its <code>.env</code> file.</p>
              <form className="cc-form" onSubmit={connect} aria-busy={busy === "connect"}>
                <label htmlFor="cc-url">Runner address</label>
                <input id="cc-url" type="url" inputMode="url" autoComplete="url" spellCheck={false} placeholder="https://claude.yourdomain.com" value={urlInput} onChange={(event) => setUrlInput(event.target.value)} required disabled={busy !== null} />
                <label htmlFor="cc-key">Access key</label>
                <input id="cc-key" type="password" autoComplete="off" spellCheck={false} placeholder="RUNNER_ACCESS_KEY" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} required disabled={busy !== null} />
                <label className="cc-check"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy !== null} />Remember the key on this device</label>
                <button className="button primary" disabled={busy !== null}>{busy === "connect" ? <><LoaderCircle className="spin" size={15} aria-hidden="true" />Connecting…</> : "Connect server"}</button>
              </form>
              <details className="cc-details">
                <summary>Set up the runner on a VPS</summary>
                <ol>
                  <li>Copy <code>apps/claude-runner</code> to the server and create <code>.env</code> from <code>.env.example</code>.</li>
                  <li>Point your domain at the server, then run <code>docker compose --profile https up -d --build</code>.</li>
                  <li>Paste <code>https://</code> plus your domain and the access key here.</li>
                </ol>
              </details>
            </>}
            {serverError && <Notice error>{serverError}</Notice>}
          </section>

          <section className={`cc-card ${connection && status ? "" : "is-waiting"}`} aria-labelledby="cc-auth-title">
            <div className="cc-card-head">
              <span className="cc-step"><AgentIcon host="claude" size={16} /></span>
              <h2 id="cc-auth-title">{signedIn ? "Claude subscription" : "Connect your Claude subscription"}</h2>
              {signedIn && <span className="cc-chip positive"><Check size={13} aria-hidden="true" />Signed in</span>}
            </div>
            {!connection || !status ? <p>Connect your server first. Sign-in happens on the server, so your Claude session stays there.</p>
              : signedIn ? <>
                <p>Claude Code on your server uses your Claude subscription{status.auth.authMethod === "oauth_token" || status.tokenStored ? " through a long-lived token" : ""}.</p>
                {(status.auth.email || status.auth.subscriptionType || status.auth.organization) && <dl className="cc-facts">
                  {status.auth.email && <div><dt>Account</dt><dd>{status.auth.email}</dd></div>}
                  {status.auth.subscriptionType && <div><dt>Plan</dt><dd className="cc-capitalize">{status.auth.subscriptionType}</dd></div>}
                  {status.auth.organization && <div><dt>Organization</dt><dd>{status.auth.organization}</dd></div>}
                </dl>}
                <div className="cc-row"><button className="button secondary" type="button" onClick={() => void signOut()} disabled={busy !== null || running}>{busy === "signout" ? "Signing out…" : "Sign out on server"}</button></div>
              </> : loginUrl ? <>
                <ol className="cc-steps">
                  <li>
                    <span>Sign in on Claude and approve access. Claude then shows a code.</span>
                    <a className="button primary" href={loginUrl} target="_blank" rel="noopener noreferrer">Open Claude sign-in<ExternalLink size={14} aria-hidden="true" /></a>
                  </li>
                  <li>
                    <form className="cc-form" onSubmit={finishLogin} aria-busy={busy === "finish"}>
                      <label htmlFor="cc-code">Paste the code from Claude</label>
                      <input id="cc-code" autoComplete="off" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} required disabled={busy !== null} />
                      <button className="button primary" disabled={busy !== null || !code.trim()}>{busy === "finish" ? <><LoaderCircle className="spin" size={15} aria-hidden="true" />Finishing…</> : "Finish sign-in"}</button>
                    </form>
                  </li>
                </ol>
                <button className="text-button" type="button" onClick={() => void cancelLogin()} disabled={busy === "finish"}>Cancel sign-in</button>
              </> : <>
                <p>Sign in once on the server with your Pro or Max plan. This page never sees your Claude password.</p>
                <button className="button primary" type="button" onClick={() => void startLogin()} disabled={busy !== null}>{busy === "login" ? <><LoaderCircle className="spin" size={15} aria-hidden="true" />Preparing sign-in…</> : "Sign in with Claude"}</button>
                <details className="cc-details">
                  <summary>Use a token instead</summary>
                  <form className="cc-form" onSubmit={saveToken} aria-busy={busy === "token"}>
                    <p>On a computer with Claude Code, run <code>claude setup-token</code> and paste the token it prints. It is stored only on your server.</p>
                    <label htmlFor="cc-token">Claude Code token</label>
                    <input id="cc-token" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-oat01-…" value={token} onChange={(event) => setToken(event.target.value)} required disabled={busy !== null} />
                    <button className="button secondary" disabled={busy !== null || !token.trim()}>{busy === "token" ? "Saving…" : "Save token on server"}</button>
                  </form>
                </details>
              </>}
            {authError && <Notice error>{authError}</Notice>}
          </section>
        </div>

        <section className="cc-console" aria-labelledby="cc-console-title">
          <div className="cc-console-head">
            <div className="cc-console-title">
              <h2 id="cc-console-title">Session</h2>
              {transcript.sessionId && <span className="cc-chip" title={transcript.sessionId}>{transcript.sessionId.slice(0, 8)}</span>}
              {transcript.model && <span className="cc-chip">{transcript.model}</span>}
            </div>
            <div className="cc-controls">
              <label className="sr-only" htmlFor="cc-model">Model</label>
              <select id="cc-model" value={model} onChange={(event) => setModel(event.target.value as "" | Model)} disabled={running}>
                {MODELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <label className="sr-only" htmlFor="cc-mode">Permissions</label>
              <select id="cc-mode" value={mode} onChange={(event) => setMode(event.target.value as PermissionMode)} disabled={running} aria-describedby="cc-mode-help">
                {MODES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <button className="button secondary" type="button" onClick={() => setTranscript(emptyTranscript())} disabled={running || !transcript.items.length}><Plus size={14} aria-hidden="true" />New session</button>
            </div>
          </div>
          <p id="cc-mode-help" className="cc-mode-help">{modeHelp}</p>

          <ol className="cc-transcript" ref={listRef} aria-live="polite">
            {!transcript.items.length && !transcript.live && <li className="cc-empty">
              <SquareTerminal size={22} aria-hidden="true" />
              <strong>{ready ? "Ready on your server" : "Not connected yet"}</strong>
              <span>{ready ? `Ask Claude Code to build, fix or explain something. It works in ${status?.workspace}.` : "Connect your server and your Claude subscription to start a session."}</span>
            </li>}
            {transcript.items.map((item) => <TranscriptRow key={item.id} item={item} running={running} />)}
            {transcript.live && <li className="cc-msg assistant"><span className="cc-who">Claude</span><div className="cc-text">{transcript.live}<span className="cc-caret" aria-hidden="true" /></div></li>}
            {running && !transcript.live && <li className="cc-working"><LoaderCircle className="spin" size={14} aria-hidden="true" />Working…</li>}
          </ol>

          <form className="cc-composer" onSubmit={send}>
            <label className="sr-only" htmlFor="cc-prompt">Message Claude Code</label>
            <textarea id="cc-prompt" rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={onPromptKey} placeholder={ready ? "Ask Claude Code…" : "Connect your server and subscription first"} disabled={!ready} />
            <div className="cc-composer-bar">
              <small>{ready ? "⌘ or Ctrl + Enter to send" : ""}</small>
              {running
                ? <button className="button secondary" type="button" onClick={() => void stop()}><Square size={13} aria-hidden="true" />Stop</button>
                : <button className="button primary" disabled={!ready || !prompt.trim()}><ArrowUp size={14} aria-hidden="true" />Send</button>}
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}

function TranscriptRow({ item, running }: { item: TranscriptItem; running: boolean }) {
  switch (item.kind) {
    case "user":
      return <li className="cc-msg user"><span className="cc-who">You</span><div className="cc-text">{item.text}</div></li>;
    case "assistant":
      return <li className="cc-msg assistant"><span className="cc-who">Claude</span><div className="cc-text">{item.text}</div></li>;
    case "tool": {
      const icon = item.result === undefined ? (running ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : <Wrench size={13} aria-hidden="true" />) : item.isError ? <CircleX size={13} aria-hidden="true" /> : <Wrench size={13} aria-hidden="true" />;
      const head = <><span className="cc-tool-icon">{icon}</span><strong>{item.name}</strong><code>{item.summary}</code></>;
      return <li className={`cc-tool ${item.isError ? "is-error" : ""}`}>
        {item.result ? <details><summary>{head}</summary><pre>{item.result}</pre></details> : <div className="cc-tool-line">{head}</div>}
      </li>;
    }
    case "result":
      return <li className={`cc-result ${item.ok ? "" : "is-error"}`}>
        {item.ok ? <CircleCheck size={14} aria-hidden="true" /> : <CircleX size={14} aria-hidden="true" />}
        <span>{item.ok ? "Done" : item.text || "Claude Code reported an error"}{item.durationMs !== undefined && ` · ${(item.durationMs / 1000).toFixed(1)}s`}{item.turns !== undefined && ` · ${item.turns} turn${item.turns === 1 ? "" : "s"}`}</span>
      </li>;
    case "notice":
      return <li className="cc-notice">{item.error ? <Notice error>{item.text}</Notice> : <span className="cc-quiet">{item.text}</span>}</li>;
  }
}
