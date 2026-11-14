import { useEffect, useRef, useState } from "react";
import { History, LoaderCircle, Video } from "lucide-react";
import type { ContentItem, ContentVersion } from "@castroom/contracts";
import { Notice, dateLabel } from "../components/ui";

/** Saved history for one item. Restoring never rewrites history: the old content is saved again as a new version. */
export function Versions({
  item,
  timezone,
  load,
  restore,
  blocked,
}: {
  item: ContentItem;
  timezone: string;
  load: (contentId: string) => Promise<ContentVersion[]>;
  restore: (revision: number) => Promise<ContentItem>;
  /** Why restoring is unavailable right now (unsaved edits, offline…), or "" when it is available. */
  blocked: string;
}) {
  const [versions, setVersions] = useState<ContentVersion[] | null>(null);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const request = useRef(0);
  async function refresh() {
    const current = ++request.current;
    setError("");
    try {
      const next = await load(item.id);
      if (current === request.current) setVersions(next);
    } catch (reason) {
      if (current === request.current) setError(reason instanceof Error ? reason.message : "Versions could not be loaded.");
    }
  }
  useEffect(() => {
    void refresh();
    return () => { request.current++; };
  }, [item.id, item.revision]);
  async function restoreVersion(revision: number) {
    if (restoring !== null || blocked) return;
    setRestoring(revision); setError(""); setStatus("");
    try {
      const saved = await restore(revision);
      setStatus(`Version ${revision} restored as version ${saved.revision}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That version could not be restored. Nothing changed.");
    } finally { setRestoring(null); }
  }
  return (
    <section className="version-panel" aria-label="Saved versions">
      <p className="version-intro"><History size={14} aria-hidden="true" />Every save is kept. Restoring a version saves it again as the newest one.</p>
      {blocked && <p className="version-blocked">{blocked}</p>}
      {error && <Notice error>{error} <button className="text-button" onClick={() => void refresh()}>Try again</button></Notice>}
      <p className="sr-only" role="status">{status}</p>
      {status && <p className="version-status" aria-hidden="true">{status}</p>}
      {versions === null && !error && <p className="version-loading" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />Loading versions…</p>}
      {versions?.length === 0 && <p className="muted">No saved versions were found for this item.</p>}
      {!!versions?.length && (
        <ol className="version-list">
          {versions.map((version) => {
            const current = version.revision === item.revision;
            return (
              <li key={version.revision} className={current ? "is-current" : undefined}>
                <div className="version-heading">
                  <strong>Version {version.revision}</strong>
                  {current && <span className="status-chip">Current</span>}
                  {version.hasMedia && <span className="version-media"><Video size={12} aria-hidden="true" />Video rendered</span>}
                </div>
                <small>{version.summary || "Saved"} · {version.actor} · {dateLabel(version.createdAt, timezone)}</small>
                <details>
                  <summary>Read script</summary>
                  <p className="version-script">{version.script || "No script in this version."}</p>
                </details>
                {!current && (
                  <button className="button secondary" disabled={restoring !== null || Boolean(blocked)} onClick={() => void restoreVersion(version.revision)}>
                    {restoring === version.revision ? "Restoring…" : `Restore version ${version.revision} as new`}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
