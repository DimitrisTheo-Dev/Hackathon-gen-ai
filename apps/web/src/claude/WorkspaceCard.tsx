import { useEffect, useState, type FormEvent } from "react";
import { FolderGit2, LoaderCircle, Plus, RotateCcw, Upload } from "lucide-react";
import { Notice } from "../components/ui";
import { RunnerError, type Project, type RunnerClient, type Workspace, type WorkspaceSave } from "./runner";

const sizeOf = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const validName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name);
const reason = (failure: unknown, fallback: string) => (failure instanceof RunnerError ? failure.message : fallback);

/**
 * The project Claude works in, and its copies in the user's own cloud folder.
 * `projects` comes from the machines database; it is null on a plain runner, where the name is typed.
 */
export function WorkspaceCard({ client, enabled, running, project, onProject, projects, onCreateProject, refreshKey }: {
  client: RunnerClient;
  enabled: boolean;
  running: boolean;
  project: string;
  onProject: (id: string) => void;
  projects: Project[] | null;
  onCreateProject?: (title: string) => Promise<void>;
  refreshKey: number;
}) {
  const [draft, setDraft] = useState(project);
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [busy, setBusy] = useState<null | "list" | "save" | "create" | string>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const known = projects?.some((item) => item.id === project) ?? false;

  useEffect(() => { setDraft(project); }, [project]);
  useEffect(() => {
    if (!enabled || !validName(project)) { setWorkspace(null); return; }
    let active = true;
    setBusy((current) => current ?? "list"); setError("");
    client.workspace(project)
      .then((loaded) => { if (active) setWorkspace(loaded); })
      .catch((failure) => { if (active) setError(reason(failure, "Couldn't load this project's saves.")); })
      .finally(() => { if (active) setBusy((current) => (current === "list" ? null : current)); });
    return () => { active = false; };
  }, [client, enabled, project, refreshKey]);

  async function saveVersion() {
    if (busy || running) return;
    setBusy("save"); setError(""); setDone("");
    try {
      const { save } = await client.saveWorkspace(project);
      setDone(`Saved a version: ${save.files ?? "all"} files (${sizeOf(save.bytes)}).`);
      setWorkspace(await client.workspace(project));
    } catch (failure) { setError(reason(failure, "Couldn't save a version.")); }
    finally { setBusy(null); }
  }
  async function restore(item: WorkspaceSave) {
    if (busy || running) return;
    setBusy(item.key); setError(""); setDone("");
    try {
      await client.restoreWorkspace(project, item.key);
      setDone(`Restored the version from ${when(item.savedAt)}. The files it replaced were saved as a new version.`);
      setWorkspace(await client.workspace(project));
    } catch (failure) { setError(reason(failure, "Couldn't restore that version.")); }
    finally { setBusy(null); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onCreateProject || busy || !title.trim()) return;
    setBusy("create"); setError(""); setDone("");
    try { await onCreateProject(title.trim()); setTitle(""); setAdding(false); }
    catch (failure) { setError(reason(failure, "Couldn't create the project.")); }
    finally { setBusy(null); }
  }
  function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (validName(draft) && draft !== project) onProject(draft);
  }

  return (
    <section className="cc-card" aria-labelledby="cc-project-title">
      <div className="cc-card-head">
        <span className="cc-step"><FolderGit2 size={16} aria-hidden="true" /></span>
        <h2 id="cc-project-title">Project</h2>
      </div>

      {projects ? <>
        <div className="cc-form">
          <label htmlFor="cc-project">Claude works in</label>
          <div className="cc-inline">
            <select id="cc-project" value={project} onChange={(event) => onProject(event.target.value)} disabled={running || busy !== null}>
              {!known && <option value={project}>{project}</option>}
              {projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
            {onCreateProject && !adding && <button className="button secondary" type="button" onClick={() => setAdding(true)} disabled={running || busy !== null}><Plus size={14} aria-hidden="true" />New</button>}
          </div>
        </div>
        {adding && <form className="cc-form" onSubmit={create}>
          <label htmlFor="cc-new-project">New project name</label>
          <div className="cc-inline">
            <input id="cc-new-project" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} autoComplete="off" autoFocus disabled={busy !== null} />
            <button className="button primary" disabled={busy !== null || !title.trim()}>{busy === "create" ? "Creating…" : "Create"}</button>
          </div>
          <button className="text-button" type="button" onClick={() => { setAdding(false); setTitle(""); }}>Cancel</button>
        </form>}
      </> : <form className="cc-form" onSubmit={rename}>
        <label htmlFor="cc-project">Claude works in</label>
        <div className="cc-inline">
          <input id="cc-project" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} autoComplete="off" maxLength={64} aria-invalid={!validName(draft)} disabled={running || busy !== null} />
          <button className="button secondary" disabled={running || busy !== null || !validName(draft) || draft === project}>Open</button>
        </div>
        {!validName(draft) && <small className="cc-hint">Letters, digits and dashes only.</small>}
      </form>}

      {!enabled ? <p>Cloud saving isn&rsquo;t set up on this runner. Add <code>STORE_URL</code> and <code>STORE_TOKEN</code> to its <code>.env</code>.</p> : <>
        <p className="cc-autosave">
          {workspace?.autosave
            ? <>Autosaved {when(workspace.autosave.savedAt)} · {workspace.autosave.files ?? "?"} file{workspace.autosave.files === 1 ? "" : "s"} · {sizeOf(workspace.autosave.bytes)}</>
            : busy === "list" ? "Checking your cloud folder…" : "Not saved yet. Every run saves automatically."}
        </p>
        <div className="cc-row">
          <button className="button secondary" type="button" onClick={() => void saveVersion()} disabled={busy !== null || running}>{busy === "save" ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}{busy === "save" ? "Saving…" : "Save a version"}</button>
        </div>
        {workspace && workspace.saves.length > 0 && <ul className="cc-saves" aria-label="Saved versions">
          {workspace.saves.slice(0, 6).map((item) => <li key={item.key}>
            <span><strong>{when(item.savedAt)}</strong><small>{item.files ?? "?"} files · {sizeOf(item.bytes)}</small></span>
            <button className="text-button" type="button" onClick={() => void restore(item)} disabled={busy !== null || running}>{busy === item.key ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}Restore</button>
          </li>)}
        </ul>}
        {done && <p className="cc-done" role="status">{done}</p>}
      </>}
      {error && <Notice error>{error}</Notice>}
    </section>
  );
}
