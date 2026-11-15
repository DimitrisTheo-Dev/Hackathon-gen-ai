import { useState, type CSSProperties } from "react";
import { CircleAlert, Download, ExternalLink, Film, LoaderCircle, RotateCcw, X } from "lucide-react";
import type { ReelRender } from "@castroom/contracts";

/**
 * Rendering, where people look: the "Render MP4" action beside Save, and the render's state drawn on the preview.
 * Progress only ever comes from the server's `progress` field; a queued render shows no progress at all.
 */
export type RenderGate = { ok: true } | { ok: false; short: string; reason: string };

const isActive = (render: ReelRender | undefined) => render?.state === "queued" || render?.state === "rendering";
const percent = (render: ReelRender) => Math.round(render.progress * 100);
/** Finished and failed cards someone closed stay closed while this tab is open. */
const dismissed = new Set<string>();

export function RenderAction({ latest, gate, starting, savedRevision, onRender }: { latest: ReelRender | undefined; gate: RenderGate; starting: boolean; savedRevision: number; onRender: () => void }) {
  const active = isActive(latest);
  const blocked = !gate.ok ? gate : active ? { short: "", reason: "A render of this video is already waiting or running." } : null;
  const hintId = "render-action-hint";
  let state: { tone: string; text: string } | null = null;
  if (starting) state = { tone: "pending", text: "Queuing…" };
  else if (latest?.state === "queued") state = { tone: "pending", text: "Queued" };
  else if (latest?.state === "rendering") state = { tone: "running", text: `Rendering ${percent(latest)}%` };
  else if (!gate.ok) state = { tone: "blocked", text: gate.short };
  else if (latest?.state === "succeeded" && latest.outputFile?.url) state = { tone: "done", text: latest.compositionRevision === savedRevision ? "MP4 ready" : `Version ${latest.compositionRevision} MP4 ready` };
  else if (latest?.state === "failed") state = { tone: "failed", text: "Last render failed" };
  return (
    <div className="render-action">
      <button type="button" className={`button ${gate.ok ? "primary" : "secondary"} render-button`} disabled={!!blocked || starting} aria-describedby={state ? hintId : undefined} title={blocked?.reason || undefined} onClick={onRender}>
        {starting || active ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Film size={14} aria-hidden="true" />}
        Render MP4
      </button>
      {state && (
        <span id={hintId} className={`render-state ${state.tone}`}>
          <span className="render-state-dot" aria-hidden="true" />
          {state.tone === "done" && latest?.outputFile?.url ? <a href={latest.outputFile.url} target="_blank" rel="noreferrer">{state.text}</a> : state.text}
        </span>
      )}
    </div>
  );
}

/** The latest render's state over the preview: an honest status card and, while it works, a calm film animation. */
export function RenderStage({ latest, savedRevision, canRender, canRetry, onCancel, onRetry }: { latest: ReelRender | undefined; savedRevision: number; canRender: boolean; canRetry: boolean; onCancel: (render: ReelRender) => void; onRetry: () => void }) {
  const [, setTick] = useState(0);
  if (!latest || latest.state === "cancelled") return null;
  const key = `${latest.id}:${latest.state}`;
  const close = () => {
    dismissed.add(key);
    setTick((tick) => tick + 1);
  };
  const active = isActive(latest);
  if (!active && dismissed.has(key)) return null;
  if (latest.state === "succeeded" && !latest.outputFile?.url) return null;
  const progress = latest.state === "rendering" ? latest.progress : 0;
  return (
    <div className={`render-stage ${latest.state}`} style={{ "--render-p": progress } as CSSProperties}>
      {active && (
        <div className="render-fx" aria-hidden="true">
          <div className="render-veil" />
          {latest.state === "rendering" && <div className="render-scan"><span /></div>}
          <div className="render-sweep" />
          <div className="render-strip start" />
          <div className="render-strip end" />
        </div>
      )}
      {latest.state === "succeeded" && <div className="render-done-glow" aria-hidden="true" />}
      <div className="render-card" role="status" aria-live="polite">
        {latest.state === "queued" && (
          <>
            <div className="render-card-head">
              <span className="render-card-icon pending" aria-hidden="true"><span /></span>
              <strong>Queued — waiting for a render worker</strong>
            </div>
            <p>Version {latest.compositionRevision} starts drawing when a worker picks it up. Nothing has been drawn yet.</p>
            {canRender && <button type="button" className="render-card-link" onClick={() => onCancel(latest)}>Cancel render</button>}
          </>
        )}
        {latest.state === "rendering" && (
          <>
            <div className="render-card-head">
              <span className="render-card-icon running" aria-hidden="true"><LoaderCircle size={14} className="spin" /></span>
              <strong>Rendering version {latest.compositionRevision}</strong>
              <span className="render-card-pct">{percent(latest)}%</span>
            </div>
            <div className="render-bar" role="progressbar" aria-label="Render progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(latest)}><span /></div>
            {canRender && <button type="button" className="render-card-link" onClick={() => onCancel(latest)}>Cancel render</button>}
          </>
        )}
        {latest.state === "succeeded" && latest.outputFile?.url && (
          <>
            <div className="render-card-head">
              <span className="render-card-icon done" aria-hidden="true"><Film size={13} /></span>
              <strong>MP4 ready · version {latest.compositionRevision}</strong>
              <button type="button" className="render-card-close" aria-label="Close" onClick={close}><X size={14} /></button>
            </div>
            {latest.compositionRevision !== savedRevision && <p>Your edit has changed since. Render again to include the newer version.</p>}
            <div className="render-card-actions">
              <a className="render-card-button" href={latest.outputFile.url} download={latest.outputFile.name}><Download size={14} aria-hidden="true" />Download</a>
              <a className="render-card-button quiet" href={latest.outputFile.url} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />Open</a>
            </div>
          </>
        )}
        {latest.state === "failed" && (
          <>
            <div className="render-card-head">
              <span className="render-card-icon failed" aria-hidden="true"><CircleAlert size={14} /></span>
              <strong>Render failed</strong>
              <button type="button" className="render-card-close" aria-label="Close" onClick={close}><X size={14} /></button>
            </div>
            <p>{latest.error?.trim() || "The render worker stopped without giving a reason."}</p>
            {canRetry && <div className="render-card-actions"><button type="button" className="render-card-button" onClick={onRetry}><RotateCcw size={14} aria-hidden="true" />Try again</button></div>}
          </>
        )}
      </div>
    </div>
  );
}
