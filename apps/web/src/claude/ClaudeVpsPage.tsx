import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Check, ChevronRight, CircleCheck, CircleX, ExternalLink, LoaderCircle, Moon, Plus, RefreshCw, Server, Square, SquareTerminal, Wrench } from "lucide-react";
import { AgentIcon } from "../components/AgentIcon";
import { Mark, Notice } from "../components/ui";
import { supabase } from "../lib/supabase";
import { codeFitsLogin, createMachineTokenSource, createRunnerClient, isCodeForLogin, normalizeRunnerUrl, RunnerError, type Machine, type Model, type PermissionMode, type Project, type RunnerStatus } from "./runner";
import { addNotice, addUserPrompt, applyEvent, emptyTranscript, type Transcript, type TranscriptItem } from "./transcript";
import { WorkspaceCard } from "./WorkspaceCard";
import "./claude.css";

const STORE = "faceful.claudeRunner";
/** The machines gateway (apps/machines). When set, the page offers it as the default address. */
const GATEWAY = (import.meta.env.VITE_CLAUDE_GATEWAY_URL as string | undefined)?.trim().replace(/\/+$/, "") || "";
/** Local development only: a personal token from the gitignored .env.local, so the page connects by itself. Never in a production build. */
const DEV_TOKEN = import.meta.env.DEV ? ((import.meta.env.VITE_CLAUDE_GATEWAY_TOKEN as string | undefined)?.trim() ?? "") : "";
/** `session` means the Faceful sign-in is the credential, so there is no key to keep. */
type Connection = { url: string; key: string; session?: boolean };
const readProject = () => { try { return localStorage.getItem(`${STORE}.project`) || "default"; } catch { return "default"; } };
/** The gateway gets a ten-minute token the engine trades for the Faceful session, never the session itself. */
let machineToken: (() => Promise<string>) | null = null;
const gatewayToken = () => (machineToken ??= createMachineTokenSource(import.meta.env.VITE_CASTROOM_API_URL || location.origin, async () => (await supabase?.auth.getSession())?.data.session?.access_token ?? null))();

function loadConnection(): Connection | null {
  try {
    const url = localStorage.getItem(`${STORE}.url`);
    const key = sessionStorage.getItem(`${STORE}.key`) ?? localStorage.getItem(`${STORE}.key`);
    if (url && key) return { url, key };
  } catch { /* fall through to the local default */ }
  return GATEWAY && DEV_TOKEN ? { url: GATEWAY, key: DEV_TOKEN } : null;
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

/**
 * Opens Claude's sign-in in a small window during the click itself, so no popup blocker stops it, before the machine
 * has even woken. It shows a holding line until connectClaude points it at the sign-in link. The window never gets a
 * reference back to this page. Null when the browser refused it; the page then offers the link as a button.
 */
function openClaudeWindow(): Window | null {
  const width = 520, height = 760;
  const left = Math.round(window.screenX + Math.max(0, (window.outerWidth - width) / 2));
  const top = Math.round(window.screenY + Math.max(0, (window.outerHeight - height) / 3));
  let popup: Window | null = null;
  try { popup = window.open("", "faceful-claude-sign-in", `popup,width=${width},height=${height},left=${left},top=${top}`); } catch { popup = null; }
  if (!popup) return null;
  try {
    popup.opener = null;
    popup.document.title = "Opening Claude…";
    const note = popup.document.createElement("p");
    note.textContent = "Opening Claude sign-in…";
    note.style.cssText = "font:15px system-ui,sans-serif;color:#6b6b66;text-align:center;margin-top:40vh";
    popup.document.body.replaceChildren(note);
  } catch { /* still on Claude's site from an earlier try: it gets the new link below */ }
  return popup;
}

export default function ClaudeVpsPage() {
  const [connection, setConnection] = useState<Connection | null>(loadConnection);
  /** The gateway turned this Faceful session down, so the page stops offering it by itself. */
  const [sessionRefused, setSessionRefused] = useState(false);
  /** A gateway is set up but nobody is signed in to Faceful here, so there is no cloud machine to open. */
  const [signedOut, setSignedOut] = useState(false);
  /**
   * The sign-in window this page opened. Closing it once Claude is connected is best effort: Claude's sign-in pages send
   * Cross-Origin-Opener-Policy, which cuts this page's hold on the window, so usually the person closes it.
   */
  const popupRef = useRef<Window | null>(null);
  const [popupOpened, setPopupOpened] = useState(false);
  /** A paste and a clipboard read can arrive together; only the first one is sent. */
  const finishing = useRef(false);
  const client = useMemo(() => (connection ? createRunnerClient(connection.url, connection.session ? gatewayToken : connection.key) : null), [connection]);
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
      // 403: this account has no cloud machine (yet). The page says why and offers your own server instead.
      if (error instanceof RunnerError && (error.status === 401 || (connection?.session && error.status === 403))) {
        if (connection?.session) setSessionRefused(true);
        saveConnection(null); setConnection(null); setStatus(null); setMachine(null); setProjects(null);
      }
    } finally { setBusy(null); }
  }
  useEffect(() => { document.title = "Claude Code · Faceful"; }, []);
  useEffect(() => { if (client) void refresh(client); }, [client]); // eslint-disable-line react-hooks/exhaustive-deps
  // Signed in to Faceful and a gateway is configured: your own machine connects by itself.
  useEffect(() => {
    if (connection || !GATEWAY || !supabase || sessionRefused) return;
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) setConnection({ url: GATEWAY, key: "", session: true });
      else setSignedOut(true);
    });
    return () => { active = false; };
  }, [connection, sessionRefused]);
  // Back from the Claude window: the cursor waits in the code field, ready for a paste. Where this browser already
  // lets the page read the clipboard, a code copied for exactly this sign-in connects without the paste.
  useEffect(() => {
    if (!loginUrl) return;
    const onFocus = async () => {
      if (code || finishing.current) return;
      document.getElementById("cc-code")?.focus();
      try {
        const permission = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
        if (permission?.state !== "granted") return;
        const copied = (await navigator.clipboard.readText()).trim();
        if (isCodeForLogin(copied, loginUrl)) { setCode(copied); void finishLogin(copied); }
      } catch { /* no clipboard access here: the paste does it */ }
    };
    const listener = () => void onFocus();
    window.addEventListener("focus", listener);
    return () => window.removeEventListener("focus", listener);
  }, [loginUrl, code]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => popupRef.current?.close(), []);

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
  const stage = !connection ? "server" : signedIn ? "ready" : loginUrl ? "code" : "auth";
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

  /**
   * The one button: wakes the machine if it sleeps, starts Claude's sign-in on it and points the window opened during
   * the click at Claude. All that is left is approving there and pasting the code Claude shows.
   */
  async function connectClaude() {
    if (!client || busy || running) return;
    const popup = openClaudeWindow();
    popupRef.current = popup; setPopupOpened(popup !== null);
    setBusy("login"); setAuthError(""); setServerError(""); setCode("");
    try {
      const current = status ?? await client.status(); // this call wakes a sleeping machine
      if (!status) { setStatus(current); if (machine) void client.machine().then(setMachine).catch(() => undefined); }
      if (current.auth.loggedIn) { popup?.close(); return; }
      const { url } = await client.startLogin();
      setLoginUrl(url);
      if (popup && !popup.closed) popup.location.href = url;
      else setPopupOpened(false);
    } catch (error) { popup?.close(); setAuthError(problem(error)); }
    finally { setBusy(null); }
  }
  async function finishLogin(value: string) {
    const entered = value.trim();
    if (!client || busy || finishing.current || !entered) return;
    if (loginUrl && !codeFitsLogin(entered, loginUrl)) { setAuthError("That code is from an earlier sign-in. Copy the newest code from the Claude window."); setCode(""); return; }
    finishing.current = true;
    setBusy("finish"); setAuthError("");
    try {
      await client.finishLogin(entered);
      setLoginUrl(null); setCode("");
      popupRef.current?.close(); popupRef.current = null;
      setStatus(await client.status());
    } catch (error) { setAuthError(problem(error)); setCode(""); if (error instanceof RunnerError && error.code === "login_not_started") setLoginUrl(null); }
    finally { setBusy(null); finishing.current = false; }
  }
  /** Claude's page has a copy button, so a paste is the whole code: it connects without another click. */
  function onCodePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text").trim();
    if (!pasted || busy) return;
    event.preventDefault();
    setCode(pasted);
    void finishLogin(pasted);
  }
  async function cancelLogin() {
    setLoginUrl(null); setCode(""); setAuthError("");
    popupRef.current?.close(); popupRef.current = null;
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
        <h1 className="cc-header-title">Claude Code</h1>
        <span className="cc-chip cc-header-tag">Preview</span>
      </header>
      <main className="cc-layout">
        <div className="cc-setup">
          <section className="cc-card cc-connect" aria-labelledby="cc-auth-title" aria-busy={busy === "login" || busy === "finish"}>
            <div className="cc-card-head">
              <span className="cc-step"><AgentIcon host="claude" size={16} /></span>
              <h2 id="cc-auth-title">{signedIn ? "Claude subscription" : "Connect your Claude subscription"}</h2>
              {signedIn && <span className="cc-chip positive"><Check size={13} aria-hidden="true" />Connected</span>}
            </div>
            {signedIn && status ? <>
              <p>Claude Code uses your Claude plan{status.auth.authMethod === "oauth_token" || status.tokenStored ? " through a long-lived token" : ""}, never API billing.</p>
              {(status.auth.email || status.auth.subscriptionType || status.auth.organization) && <dl className="cc-facts">
                {status.auth.email && <div><dt>Account</dt><dd>{status.auth.email}</dd></div>}
                {status.auth.subscriptionType && <div><dt>Plan</dt><dd className="cc-capitalize">{status.auth.subscriptionType}</dd></div>}
                {status.auth.organization && <div><dt>Organization</dt><dd>{status.auth.organization}</dd></div>}
              </dl>}
            </> : loginUrl ? <>
              <ol className="cc-steps">
                <li>
                  <span>{popupOpened ? "Approve access in the Claude window." : "Open Claude and approve access."} Claude then shows a code.</span>
                  {popupOpened
                    ? <a className="text-button" href={loginUrl} target="_blank" rel="noopener noreferrer">Open the Claude window again<ExternalLink size={13} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
                    : <a className="button primary" data-cc-focus="code" href={loginUrl} target="_blank" rel="noopener noreferrer">Open Claude<ExternalLink size={14} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>}
                </li>
                <li>
                  <form className="cc-form" onSubmit={(event) => { event.preventDefault(); void finishLogin(code); }} aria-busy={busy === "finish"}>
                    <label htmlFor="cc-code">Copy the code and paste it here</label>
                    <input id="cc-code" className="cc-mono" data-cc-focus={popupOpened ? "code" : undefined} autoComplete="off" {...exact} value={code} onChange={(event) => setCode(event.target.value)} onPaste={onCodePaste} required disabled={busy !== null} aria-describedby="cc-code-help" />
                    <small id="cc-code-help" className="cc-hint">{busy === "finish" ? "Connecting Claude…" : "It connects as soon as you paste."}</small>
                    {code.trim() && busy !== "finish" && <button className="button primary" disabled={busy !== null}>Connect</button>}
                  </form>
                </li>
              </ol>
              <button className="text-button" type="button" onClick={() => void cancelLogin()} disabled={busy === "finish"}>Cancel</button>
            </> : <>
              <p>{client
                ? `Use your Pro or Max plan. Claude signs in on ${machine ? "your own cloud machine" : "your server"}, so Faceful never sees your Claude password.`
                : sessionRefused ? "Cloud machines are invite-only for now. You can still use your own server below."
                : signedOut ? "Sign in to Faceful to get your own cloud machine, or use your own server below."
                : GATEWAY && supabase ? "Opening your cloud machine…"
                : "Add your server below first. Claude signs in there, so Faceful never sees your Claude password."}</p>
              {signedOut && !client && <a className="text-button" href="/studio/">Sign in to Faceful</a>}
              <button className="button primary cc-connect-button" data-cc-focus="auth" type="button" onClick={() => void connectClaude()} disabled={!client || busy !== null}>
                {busy === "login" ? <><LoaderCircle className="spin" size={15} aria-hidden="true" />{status ? "Opening Claude…" : machine ? "Waking your machine…" : "Connecting…"}</> : <><AgentIcon host="claude" size={16} />Connect Claude</>}
              </button>
              {client && status && <details className="cc-details">
                <summary>Use a token instead</summary>
                <form className="cc-form" onSubmit={saveToken} aria-busy={busy === "token"}>
                  <p>On a computer with Claude Code, run <code>claude setup-token</code> and paste the token it prints. It is stored only on {machine ? "your machine" : "your server"}.</p>
                  <label htmlFor="cc-token">Claude Code token</label>
                  <input id="cc-token" type="password" autoComplete="off" {...exact} placeholder="sk-ant-oat01-…" value={token} onChange={(event) => setToken(event.target.value)} required disabled={busy !== null} />
                  <button className="button secondary" disabled={busy !== null || !token.trim()}>{busy === "token" ? "Saving…" : "Save token"}</button>
                </form>
              </details>}
            </>}
            {authError && <Notice error>{authError}</Notice>}
            {connection && serverError && <Notice error>{serverError}</Notice>}

            {connection && <div className="cc-machine">
              <p className="cc-machine-line">
                <Server size={14} aria-hidden="true" />
                <span>
                  {machine ? "Your cloud machine" : "Your server"}
                  {" · "}
                  {busy === "refresh" ? (machine ? "waking…" : "checking…") : status ? (machine ? `awake, sleeps after ${machine.sleepAfterMinutes} min idle` : "connected") : machine ? "asleep" : "not reachable"}
                  {status?.claudeVersion && <span className="cc-machine-version"> · Claude Code {status.claudeVersion}</span>}
                </span>
              </p>
              <div className="cc-row">
                {(!status || !machine) && <button className="text-button" type="button" data-cc-focus={machine && !status ? "server" : undefined} onClick={() => void refresh()} disabled={busy !== null}><RefreshCw className={busy === "refresh" ? "spin" : undefined} size={13} aria-hidden="true" />{machine && !status ? "Wake" : "Check again"}</button>}
                {machine && status && <button className="text-button" type="button" onClick={() => void sleepNow()} disabled={busy !== null || running}><Moon size={13} aria-hidden="true" />Save and sleep</button>}
                {signedIn && <button className="text-button" type="button" onClick={() => void signOut()} disabled={busy !== null || running}>{busy === "signout" ? "Signing out…" : "Sign out of Claude"}</button>}
                {!connection.session && <button className="text-button" type="button" onClick={forget} disabled={running}>{machine ? "Disconnect" : "Forget server"}</button>}
              </div>
            </div>}
          </section>
          {client && status && <WorkspaceCard client={client} enabled={status.store === true} running={running} project={project} onProject={chooseProject} projects={projects} onCreateProject={machine ? createProject : undefined} refreshKey={refreshKey} />}

          {!connection && <details className="cc-card cc-own" open={!GATEWAY || !supabase || sessionRefused || signedOut || undefined}>
            <summary>Use your own server</summary>
            <p>Run the official Claude Code CLI on a server you control. Paste its address and access key.</p>
            <form className="cc-form" onSubmit={connect} aria-busy={busy === "connect"}>
              <label htmlFor="cc-url">Address</label>
              <input id="cc-url" data-cc-focus="server" type="url" inputMode="url" autoComplete="url" {...exact} placeholder="https://claude.yourdomain.com" value={urlInput} onChange={(event) => setUrlInput(event.target.value)} required disabled={busy !== null} aria-describedby={serverError ? "cc-server-error" : undefined} />
              <label htmlFor="cc-key">Access key</label>
              <input id="cc-key" type="password" autoComplete="off" {...exact} placeholder="RUNNER_ACCESS_KEY or fgw2.…" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} required disabled={busy !== null} aria-describedby={serverError ? "cc-server-error" : undefined} />
              <label className="cc-check"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy !== null} />Remember the key on this device</label>
              <button className="button secondary" disabled={busy !== null}>{busy === "connect" ? <><LoaderCircle className="spin" size={15} aria-hidden="true" />Connecting…</> : "Connect server"}</button>
            </form>
            {serverError && <div id="cc-server-error"><Notice error>{serverError}</Notice></div>}
            <ol className="cc-own-steps">
              <li>Copy <code>apps/claude-runner</code> to the server and create <code>.env</code> from <code>.env.example</code>.</li>
              <li>Point your domain at the server, then run <code>docker compose --profile https up -d --build</code>.</li>
              <li>Paste <code>https://</code> plus your domain and the access key above.</li>
            </ol>
          </details>}
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
              <strong>{ready ? "Ready" : "Not connected yet"}</strong>
              <span>{ready ? (transcript.sessionId ? "Your next message continues the last conversation in this project. Use New session to start fresh." : `Ask Claude Code to build, fix or explain something. It works in ${status?.workspace}/${project}.`) : "Connect your Claude subscription to start a session."}</span>
            </li>}
            {items.map((item, index) => <TranscriptRow key={item.id} item={item} running={running} lead={items[index - 1]?.kind === "user"} />)}
            {transcript.live && <li className="cc-msg assistant" aria-hidden="true">{opensTurn && <Who />}<div className="cc-text"><Rich text={transcript.live} /><span className="cc-caret" /></div></li>}
            {running && !transcript.live && <li className="cc-working">{opensTurn && <Who />}<span className="cc-working-line"><LoaderCircle className="spin" size={14} aria-hidden="true" />Working…</span></li>}
          </ol>

          <form className="cc-composer" onSubmit={send}>
            <div className="cc-composer-box" data-disabled={!ready || undefined}>
              <label className="sr-only" htmlFor="cc-prompt">Message Claude Code</label>
              <textarea id="cc-prompt" data-cc-focus="ready" rows={2} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={onPromptKey} placeholder={ready ? "Ask Claude Code…" : "Connect Claude first"} disabled={!ready} aria-keyshortcuts="Meta+Enter Control+Enter" />
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
