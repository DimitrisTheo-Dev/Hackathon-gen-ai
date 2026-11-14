import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Check, ChevronRight, CircleCheck, CircleX, ExternalLink, LoaderCircle, Moon, Plus, RefreshCw, Server, Square, SquareTerminal, Wrench } from "lucide-react";
import { AgentIcon } from "../components/AgentIcon";
import { Mark, Notice } from "../components/ui";
import { supabase } from "../lib/supabase";
import { createRunnerClient, normalizeRunnerUrl, RunnerError, type Machine, type Model, type PermissionMode, type Project, type RunnerStatus } from "./runner";
import { addNotice, addUserPrompt, applyEvent, emptyTranscript, type Transcript, type TranscriptItem } from "./transcript";
import { WorkspaceCard } from "./WorkspaceCard";
import "./claude.css";

const STORE = "faceful.claudeRunner";
/** The machines gateway (apps/machines). When set, the page offers it as the default address. */
const GATEWAY = (import.meta.env.VITE_CLAUDE_GATEWAY_URL as string | undefined)?.trim().replace(/\/+$/, "") || "";
/** `session` means the Faceful sign-in is the credential, so there is no key to keep. */
type Connection = { url: string; key: string; session?: boolean };
const readProject = () => { try { return localStorage.getItem(`${STORE}.project`) || "default"; } catch { return "default"; } };
const sessionToken = async () => (await supabase?.auth.getSession())?.data.session?.access_token ?? "";

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
/** Keys, codes and addresses are typed exactly: no capitals, corrections or spell checks on phones. */
const exact = { autoCapitalize: "none", autoCorrect: "off", spellCheck: false } as const;

export default function ClaudeVpsPage() {
  const [connection, setConnection] = useState<Connection | null>(loadConnection);
  /** The gateway turned this Faceful session down, so the page stops offering it by itself. */
  const [sessionRefused, setSessionRefused] = useState(false);
  const client = useMemo(() => (connection ? createRunnerClient(connection.url, connection.session ? sessionToken : connection.key) : null), [connection]);
  const [machine, setMachine] = useState<Machine | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [project, setProject] = useState(readProject);
  const [refreshKey, setRefreshKey] = useState(0);
  const [status, setStatus] = useState<RunnerStatus | null>(null);
  const [busy, setBusy] = useState<null | "connect" | "refresh" | "login" | "finish" | "token" | "signout">(null);
  const [serverError, setServerError] = useState("");
  const [authError, setAuthError] = useState("");
  const [urlInput, setUrlInput] = useState(() => savedUrl() || GATEWAY);
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
  const pageRef = useRef<HTMLDivElement | null>(null);

  const signedIn = status?.auth.loggedIn === true;
  const ready = Boolean(client && status && signedIn);

  async function refresh(target = client) {
    if (!target) return;
    setBusy("refresh"); setServerError("");
    try {
      // A gateway answers /v1/machine without waking anything; a plain runner has no such route.
      const info = await target.machine();
      setMachine(info);
      const list = info ? (await target.projects()).projects : null;
      setProjects(list);
      const resume = list?.find((item) => item.id === project)?.session_id;
      if (resume) setTranscript((current) => (current.items.length || current.sessionId ? current : { ...current, sessionId: resume }));
      setStatus(await target.status()); // this is the call that wakes a sleeping machine
      if (info) setMachine(await target.machine());
    } catch (error) {
      setServerError(problem(error));
      if (error instanceof RunnerError && error.status === 401) {
        if (connection?.session) setSessionRefused(true);
        saveConnection(null); setConnection(null); setStatus(null); setMachine(null); setProjects(null);
      }
    } finally { setBusy(null); }
  }
  useEffect(() => { document.title = "Claude Code on your server · Faceful"; }, []);
  useEffect(() => { if (client) void refresh(client); }, [client]); // eslint-disable-line react-hooks/exhaustive-deps
  // Signed in to Faceful and a gateway is configured: your own machine connects by itself.
  useEffect(() => {
    if (connection || !GATEWAY || !supabase || sessionRefused) return;
    let active = true;
    void supabase.auth.getSession().then(({ data }) => { if (active && data.session) setConnection({ url: GATEWAY, key: "", session: true }); });
    return () => { active = false; };
  }, [connection, sessionRefused]);

  function chooseProject(id: string) {
    if (running || id === project) return;
    setProject(id);
    try { localStorage.setItem(`${STORE}.project`, id); } catch { /* per-device convenience only */ }
    setTranscript({ ...emptyTranscript(), sessionId: projects?.find((item) => item.id === id)?.session_id ?? null });
  }
  async function createProject(title: string) {
    if (!client) return;
    const { project: created } = await client.createProject(title);
    setProjects((current) => [created, ...(current ?? [])]);
    setProject(created.id);
    try { localStorage.setItem(`${STORE}.project`, created.id); } catch { /* per-device convenience only */ }
    setTranscript(emptyTranscript());
  }
  async function sleepNow() {
    if (!client || busy || running) return;
    setBusy("refresh"); setServerError("");
    try { await client.sleepMachine(); setStatus(null); setMachine(await client.machine()); }
    catch (error) { setServerError(problem(error)); }
    finally { setBusy(null); }
  }

  useEffect(() => {
    const list = listRef.current;
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 160) list.scrollTop = list.scrollHeight;
  }, [transcript]);

  // Keyboard and screen-reader path: when a step finishes, its controls leave the page. If the page was
  // in use, focus continues at the next thing to do instead of dropping back to the top of the document.
  // It is only ever placed when nothing holds focus, and stops as soon as the person focuses something else.
  const stage = !connection || !status ? "server" : signedIn ? "ready" : loginUrl ? "code" : "auth";
  const stageSeen = useRef(stage);
  const engaged = useRef(false);
  const carryFocus = useRef(false);
  useEffect(() => {
    if (stageSeen.current !== stage) { stageSeen.current = stage; carryFocus.current = engaged.current; }
    if (!carryFocus.current || busy) return;
    const active = document.activeElement;
    if (!active || active === document.body) pageRef.current?.querySelector<HTMLElement>(`[data-cc-focus="${stage}"]`)?.focus();
  }, [stage, busy]);

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
      setMachine(await candidate.machine());
      const next = await candidate.status();
      saveConnection({ url, key }, remember);
      setStatus(next); setKeyInput(""); setConnection({ url, key });
    } catch (error) { setServerError(problem(error)); }
    finally { setBusy(null); }
  }
  function forget() {
    if (running) return;
    saveConnection(null); setConnection(null); setStatus(null); setMachine(null); setProjects(null); setLoginUrl(null); setServerError(""); setAuthError("");
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
    // What was just sent is always brought into view, wherever the transcript was scrolled to.
    requestAnimationFrame(() => { const list = listRef.current; if (list) list.scrollTop = list.scrollHeight; });
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await client.run({ prompt: text, project, sessionId: transcript.sessionId ?? undefined, model: model || undefined, permissionMode: mode }, (streamed) => setTranscript((current) => applyEvent(current, streamed)), controller.signal);
    } catch (error) {
      if ((error as Error)?.name === "AbortError") setTranscript((current) => addNotice(current, "Run stopped.", false));
      else setTranscript((current) => addNotice(current, problem(error)));
    } finally {
      setRunning(false); abortRef.current = null;
      setRefreshKey((current) => current + 1); // the run autosaved; show it
      if (machine) void client.projects().then((loaded) => setProjects(loaded.projects)).catch(() => undefined);
    }
  }
  async function stop() {
    try { await client?.stop(); } catch { abortRef.current?.abort(); }
  }
  function onPromptKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
  }

  const modeHelp = MODES.find((item) => item.value === mode)?.help;
  const projectTitle = projects?.find((item) => item.id === project)?.title ?? project;
  const items = transcript.items;
  // Claude is named once per turn, on whatever it does first.
  const opensTurn = items.at(-1)?.kind === "user";
  return (
    <div className="cc-page" ref={pageRef} data-stage={stage} onFocus={(event) => { engaged.current = true; if (!event.target.matches("[data-cc-focus]")) carryFocus.current = false; }}>
      <header className="cc-header">
        <a className="wordmark" href="/"><Mark />Faceful</a>
        <h1 className="cc-header-title">Claude Code on your server</h1>
        <span className="cc-chip cc-header-tag">Preview</span>
      </header>
      <main className="cc-layout">
        <div className="cc-setup">
          <section className="cc-card" aria-labelledby="cc-server-title">
            <div className="cc-card-head">
              <span className="cc-step"><Server size={16} aria-hidden="true" /></span>
              <h2 id="cc-server-title">{connection ? (machine ? "Your machine" : "Server") : "Connect your machine"}</h2>
              {connection && status && <span className="cc-chip positive"><Check size={13} aria-hidden="true" />{machine ? "Awake" : "Connected"}</span>}
              {connection && machine && !status && busy !== "refresh" && <span className="cc-chip"><Moon size={12} aria-hidden="true" />Asleep</span>}
            </div>
            {connection ? <>
              <dl className="cc-facts">
                <div><dt>Address</dt><dd>{connection.url}</dd></div>
                {machine && <div><dt>Size</dt><dd>{machine.instanceType} · sleeps after {machine.sleepAfterMinutes} min idle</dd></div>}
                <div><dt>Claude Code</dt><dd>{status ? status.claudeVersion ?? "Not found on the server" : busy === "refresh" ? (machine ? "Waking your machine…" : "Checking…") : machine ? "Asleep" : "Unknown"}</dd></div>
                <div><dt>Workspace</dt><dd>{status ? `${status.workspace}/${project}` : "…"}</dd></div>
              </dl>
              {serverError && <Notice error>{serverError}</Notice>}
              <div className="cc-row">
                <button className="text-button" type="button" data-cc-focus={machine && !status ? "server" : undefined} onClick={() => void refresh()} disabled={busy !== null}><RefreshCw className={busy === "refresh" ? "spin" : undefined} size={13} aria-hidden="true" />{busy === "refresh" ? (machine ? "Waking…" : "Checking…") : machine && !status ? "Wake machine" : "Check again"}</button>
                {machine && status && <button className="text-button" type="button" onClick={() => void sleepNow()} disabled={busy !== null || running}><Moon size={13} aria-hidden="true" />Save and sleep</button>}
                {!connection.session && <button className="text-button" type="button" onClick={forget} disabled={running}>{machine ? "Disconnect" : "Forget server"}</button>}
              </div>
            </> : <>
              <p>Your machine runs the official Claude Code CLI in the cloud and sleeps when idle. Paste its address and your access token. A runner on your own server works too.</p>
              <form className="cc-form" onSubmit={connect} aria-busy={busy === "connect"}>
                <label htmlFor="cc-url">Address</label>
                <input id="cc-url" data-cc-focus="server" type="url" inputMode="url" autoComplete="url" {...exact} placeholder="https://claude.yourdomain.com" value={urlInput} onChange={(event) => setUrlInput(event.target.value)} required disabled={busy !== null} aria-describedby={serverError ? "cc-server-error" : undefined} />
                <label htmlFor="cc-key">Access token</label>
                <input id="cc-key" type="password" autoComplete="off" {...exact} placeholder="fgw1.… or RUNNER_ACCESS_KEY" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} required disabled={busy !== null} aria-describedby={serverError ? "cc-server-error" : undefined} />
                <label className="cc-check"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy !== null} />Remember the key on this device</label>
                <button className="button primary" disabled={busy !== null}>{busy === "connect" ? <><LoaderCircle className="spin" size={15} aria-hidden="true" />{machine ? "Waking your machine…" : "Connecting…"}</> : "Connect"}</button>
              </form>
              {serverError && <div id="cc-server-error"><Notice error>{serverError}</Notice></div>}
              <details className="cc-details">
                <summary>Run it on your own server instead</summary>
                <ol>
                  <li>Copy <code>apps/claude-runner</code> to the server and create <code>.env</code> from <code>.env.example</code>.</li>
                  <li>Point your domain at the server, then run <code>docker compose --profile https up -d --build</code>.</li>
                  <li>Paste <code>https://</code> plus your domain and the access key here.</li>
                </ol>
              </details>
            </>}
          </section>

          <section className={`cc-card ${connection && status ? "" : "is-waiting"}`} aria-labelledby="cc-auth-title">
            <div className="cc-card-head">
              <span className="cc-step"><AgentIcon host="claude" size={16} /></span>
              <h2 id="cc-auth-title">{signedIn ? "Claude subscription" : "Connect your Claude subscription"}</h2>
              {signedIn && <span className="cc-chip positive"><Check size={13} aria-hidden="true" />Signed in</span>}
            </div>
            {!connection || !status ? <p>{connection && machine ? "Your machine is asleep. Wake it to continue; your Claude sign-in comes back with it." : "Connect your machine first. Sign-in happens on the machine, so your Claude session stays there."}</p>
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
                    <a className="button primary" data-cc-focus="code" href={loginUrl} target="_blank" rel="noopener noreferrer">Open Claude sign-in<ExternalLink size={14} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
                  </li>
                  <li>
                    <form className="cc-form" onSubmit={finishLogin} aria-busy={busy === "finish"}>
                      <label htmlFor="cc-code">Paste the code from Claude</label>
                      <input id="cc-code" className="cc-mono" autoComplete="off" {...exact} value={code} onChange={(event) => setCode(event.target.value)} required disabled={busy !== null} />
                      <button className="button primary" disabled={busy !== null || !code.trim()}>{busy === "finish" ? <><LoaderCircle className="spin" size={15} aria-hidden="true" />Finishing…</> : "Finish sign-in"}</button>
                    </form>
                  </li>
                </ol>
                <button className="text-button" type="button" onClick={() => void cancelLogin()} disabled={busy === "finish"}>Cancel sign-in</button>
              </> : <>
                <p>Sign in once on the server with your Pro or Max plan. This page never sees your Claude password.</p>
                <button className="button primary" data-cc-focus="auth" type="button" onClick={() => void startLogin()} disabled={busy !== null}>{busy === "login" ? <><LoaderCircle className="spin" size={15} aria-hidden="true" />Preparing sign-in…</> : "Sign in with Claude"}</button>
                <details className="cc-details">
                  <summary>Use a token instead</summary>
                  <form className="cc-form" onSubmit={saveToken} aria-busy={busy === "token"}>
                    <p>On a computer with Claude Code, run <code>claude setup-token</code> and paste the token it prints. It is stored only on your server.</p>
                    <label htmlFor="cc-token">Claude Code token</label>
                    <input id="cc-token" type="password" autoComplete="off" {...exact} placeholder="sk-ant-oat01-…" value={token} onChange={(event) => setToken(event.target.value)} required disabled={busy !== null} />
                    <button className="button secondary" disabled={busy !== null || !token.trim()}>{busy === "token" ? "Saving…" : "Save token on server"}</button>
                  </form>
                </details>
              </>}
            {authError && <Notice error>{authError}</Notice>}
          </section>
          {client && status && <WorkspaceCard client={client} enabled={status.store === true} running={running} project={project} onProject={chooseProject} projects={projects} onCreateProject={machine ? createProject : undefined} refreshKey={refreshKey} />}
        </div>

        <section className="cc-console" aria-labelledby="cc-console-title">
          <div className="cc-console-head">
            <div className="cc-console-title">
              <h2 id="cc-console-title">Session</h2>
              <span className="cc-chip" title={projectTitle}>{projectTitle}</span>
              {transcript.sessionId && <span className="cc-chip cc-mono" title={transcript.sessionId}>{transcript.sessionId.slice(0, 8)}</span>}
              {transcript.model && <span className="cc-chip" title={transcript.model}>{transcript.model}</span>}
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
              <button className="button secondary cc-new" type="button" onClick={() => setTranscript(emptyTranscript())} disabled={running || (!transcript.items.length && !transcript.sessionId)}><Plus size={14} aria-hidden="true" /><span>New session</span></button>
            </div>
          </div>
          <p id="cc-mode-help" className="cc-mode-help">{modeHelp}</p>

          {/* Finished items are announced as they arrive; the reply still being written is read once it is complete. */}
          <ol className="cc-transcript" ref={listRef} tabIndex={0} aria-label="Session transcript" aria-live="polite" aria-relevant="additions">
            {!items.length && !transcript.live && <li className="cc-empty" data-ready={ready || undefined}>
              <span className="cc-empty-icon"><SquareTerminal size={20} aria-hidden="true" /></span>
              <strong>{ready ? "Ready on your server" : "Not connected yet"}</strong>
              <span>{ready ? (transcript.sessionId ? "Your next message continues the last conversation in this project. Use New session to start fresh." : `Ask Claude Code to build, fix or explain something. It works in ${status?.workspace}/${project}.`) : "Connect your machine and your Claude subscription to start a session."}</span>
            </li>}
            {items.map((item, index) => <TranscriptRow key={item.id} item={item} running={running} lead={items[index - 1]?.kind === "user"} />)}
            {transcript.live && <li className="cc-msg assistant" aria-hidden="true">{opensTurn && <Who />}<div className="cc-text"><Rich text={transcript.live} /><span className="cc-caret" /></div></li>}
            {running && !transcript.live && <li className="cc-working">{opensTurn && <Who />}<span className="cc-working-line"><LoaderCircle className="spin" size={14} aria-hidden="true" />Working…</span></li>}
          </ol>

          <form className="cc-composer" onSubmit={send}>
            <div className="cc-composer-box" data-disabled={!ready || undefined}>
              <label className="sr-only" htmlFor="cc-prompt">Message Claude Code</label>
              <textarea id="cc-prompt" data-cc-focus="ready" rows={2} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={onPromptKey} placeholder={ready ? "Ask Claude Code…" : "Connect your machine and subscription first"} disabled={!ready} aria-keyshortcuts="Meta+Enter Control+Enter" />
              <div className="cc-composer-bar">
                <small>{ready ? "⌘ or Ctrl + Enter to send" : ""}</small>
                {running
                  ? <button className="button secondary" type="button" onClick={() => void stop()}><Square size={13} aria-hidden="true" />Stop</button>
                  : <button className="button primary" disabled={!ready || !prompt.trim()}><ArrowUp size={14} aria-hidden="true" />Send</button>}
              </div>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}

const Who = () => <span className="cc-who"><AgentIcon host="claude" size={14} />Claude</span>;

const FENCE = /(```[^\n`]*\n[\s\S]*?(?:```|$))/;
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/;
/** Display only: fenced blocks, `code` and **bold** in Claude's replies are drawn as such. Every other character stays as written. */
function Rich({ text }: { text: string }) {
  return <>{text.split(FENCE).map((part, index) => {
    if (index % 2) return <pre key={index}><code>{part.replace(/^```[^\n]*\n/, "").replace(/\n?```$/, "")}</code></pre>;
    const prose = part.replace(/^\n+|\n+$/g, "");
    return prose ? <span key={index}>{prose.split(INLINE).map((piece, at) => (at % 2 === 0 ? piece : piece.startsWith("`") ? <code key={at}>{piece.slice(1, -1)}</code> : <strong key={at}>{piece.slice(2, -2)}</strong>))}</span> : null;
  })}</>;
}

function TranscriptRow({ item, running, lead }: { item: TranscriptItem; running: boolean; lead: boolean }) {
  switch (item.kind) {
    case "user":
      return <li className="cc-msg user"><span className="sr-only">You</span><div className="cc-text">{item.text}</div></li>;
    case "assistant":
      return <li className="cc-msg assistant">{lead ? <Who /> : <span className="sr-only">Claude</span>}<div className="cc-text"><Rich text={item.text} /></div></li>;
    case "tool": {
      const pending = item.result === undefined;
      const icon = pending ? (running ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : <Wrench size={13} aria-hidden="true" />) : item.isError ? <CircleX size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />;
      const head = <><span className="cc-tool-icon">{icon}</span><strong>{item.name}</strong><code>{item.summary}</code>{!pending && <span className="sr-only">{item.isError ? " failed" : " finished"}</span>}</>;
      return <li className={`cc-tool ${item.isError ? "is-error" : ""}`}>
        {lead && <Who />}
        {item.result ? <details><summary>{head}<ChevronRight className="cc-tool-chevron" size={14} aria-hidden="true" /></summary><pre tabIndex={0} role="group" aria-label={`${item.name} output`}>{item.result}</pre></details> : <div className="cc-tool-line">{head}</div>}
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
