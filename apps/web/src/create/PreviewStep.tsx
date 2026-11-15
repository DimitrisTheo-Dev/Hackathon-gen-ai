import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, RotateCcw } from "lucide-react";
import type { Composition, StudioContext } from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import type { ReelMedia } from "../video/Reel";
import { savedComposition, type Presenter } from "./model";
import "./preview-step.css";

const PreviewPlayer = lazy(() => import("./PreviewPlayer"));

/**
 * The last step makes the video. Arriving on it starts production, and the step waits for the result:
 *   • a person's own take, or no presenter at all: the timeline is saved and an MP4 render is queued;
 *   • a stock AI avatar: the speaking video is rendered;
 *   • a persona from the person's own photos: made from the video studio (no automatic path here yet).
 * Leaving the step (Back, Finish later) never cancels anything; coming back with the same choices picks up the
 * same render instead of starting another.
 */
export type Production =
  | { state: "idle" }
  | { state: "working"; since: number; progress: number | null }
  | { state: "ready"; url: string }
  | { state: "failed"; message: string }
  | { state: "unavailable"; message: string };

type Handle = { kind: "timeline"; itemId: string; renderId: string } | { kind: "avatar"; campaignId: string; itemId: string };

/** Promised in the step's heading; past it the heading admits it is taking longer. */
const PROMISE_MS = 2 * 60 * 1000;
const POLL_MS = 4000;
const said = (reason: unknown, fallback: string) => (reason instanceof Error && reason.message ? reason.message : fallback);

export function useProduction({
  client,
  context,
  project,
  mode,
  composition,
  active,
}: {
  client: StudioClient;
  context: StudioContext;
  project: { campaignId: string; itemId: string; revision: number } | null;
  mode: Presenter["mode"] | "none";
  composition: Composition | null;
  active: boolean;
}) {
  const [production, setProduction] = useState<Production>({ state: "idle" });
  const [handle, setHandle] = useState<Handle | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef<string | null>(null);
  const savedFor = useRef<string | null>(null);
  const timeline = mode === "camera" || mode === "voice" || mode === "none";
  const toSave = useMemo(() => {
    if (!timeline || !composition) return null;
    try {
      return savedComposition(composition);
    } catch {
      return null;
    }
  }, [timeline, composition]);
  // Production starts again only when what would be made changes (a new take, an edited line) or on Try again.
  const signature = project ? JSON.stringify([project.itemId, project.revision, mode, toSave, attempt]) : null;

  useEffect(() => {
    if (!active || !project || !signature || started.current === signature) return;
    started.current = signature;
    const current = () => started.current === signature;
    setHandle(null);
    if (context.capabilities.mode === "fixture" || !context.capabilities.canRender) {
      setProduction({ state: "unavailable", message: "Video making isn’t connected in this workspace yet. Open it in the video studio to keep going." });
      return;
    }
    if (mode === "persona") {
      setProduction({ state: "unavailable", message: "Make your presenter’s speaking video from the video studio." });
      return;
    }
    setProduction({ state: "working", since: Date.now(), progress: null });
    void (async () => {
      try {
        if (timeline) {
          if (!toSave) throw new Error("This preview could not be turned into a video. Open it in the video studio.");
          const document = await client.getComposition(project.itemId);
          const saved = await client.saveComposition({ contentId: project.itemId, expectedRevision: document.revision, composition: toSave, operationKey: crypto.randomUUID() });
          if (!current()) return;
          savedFor.current = signature;
          const render = await client.queueRender({ contentId: project.itemId, expectedRevision: saved.revision, operationKey: crypto.randomUUID() });
          if (current()) setHandle({ kind: "timeline", itemId: project.itemId, renderId: render.id });
        } else {
          const operation = await client.renderContent({ campaignId: project.campaignId, itemIds: [project.itemId], expectedRevisions: { [project.itemId]: project.revision }, operationKey: crypto.randomUUID() });
          if (operation.state === "blocked") throw new Error("The video could not be started. Open it in the video studio to see why.");
          if (current()) setHandle({ kind: "avatar", campaignId: project.campaignId, itemId: project.itemId });
        }
      } catch (reason) {
        if (current()) setProduction({ state: "failed", message: said(reason, "The video could not be started. Your draft is saved; try again.") });
      }
    })();
  }, [active, signature]);

  // While the step is on screen and the video is being made, check on it every few seconds.
  const working = production.state === "working";
  useEffect(() => {
    if (!active || !handle || !working) return;
    let stopped = false;
    const check = async () => {
      try {
        if (handle.kind === "timeline") {
          const render = (await client.listRenders(handle.itemId)).find((entry) => entry.id === handle.renderId);
          if (stopped || !render) return;
          if (render.state === "succeeded" && render.outputFile?.url) setProduction({ state: "ready", url: render.outputFile.url });
          else if (render.state === "failed" || render.state === "cancelled") setProduction({ state: "failed", message: render.error ?? "The render stopped before it finished. Try again." });
          else setProduction((now) => (now.state === "working" ? { ...now, progress: render.progress > 0 ? render.progress : null } : now));
        } else {
          const item = (await client.getCampaign(handle.campaignId)).items.find((entry) => entry.id === handle.itemId);
          if (stopped || !item) return;
          if ((item.status === "ready" || item.status === "needs_review") && item.media) setProduction({ state: "ready", url: item.media.url });
          else if (item.status === "failed") setProduction({ state: "failed", message: "The video could not be made. Try again, or open it in the video studio." });
        }
      } catch {
        // A missed check is retried on the next one; the video keeps being made either way.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [active, handle, working, client]);

  return {
    production,
    /** True once this exact timeline is saved, so opening the video studio does not save it a second time. */
    timelineSaved: signature !== null && savedFor.current === signature,
    retry: () => setAttempt((count) => count + 1),
  };
}

/** Whether the rough preview is shown. Kept per browser; it is only a viewing preference. */
export function usePreviewShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem("faceful.newProject.preview") !== "hidden";
    } catch {
      return true;
    }
  });
  return [
    shown,
    (next: boolean) => {
      setShown(next);
      try {
        localStorage.setItem("faceful.newProject.preview", next ? "shown" : "hidden");
      } catch {
        // Private windows may refuse storage; the choice still holds for this visit.
      }
    },
  ];
}

export function PreviewStep({
  production,
  onRetry,
  composition,
  media,
  showPreview,
}: {
  production: Production;
  onRetry: () => void;
  composition: Composition | null;
  media: ReelMedia;
  showPreview: boolean;
}) {
  const waiting = production.state === "idle" || production.state === "working";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting]);
  const slow = production.state === "working" && now - production.since > PROMISE_MS;
  const progress = production.state === "working" ? production.progress : null;

  const title =
    production.state === "ready"
      ? "Your video is ready"
      : production.state === "failed"
        ? "Your video couldn’t be made"
        : production.state === "unavailable"
          ? "Your draft is saved"
          : slow
            ? "Almost ready"
            : "Your video will be ready in less than 2 minutes";
  const lead =
    production.state === "failed" || production.state === "unavailable"
      ? production.message
      : production.state === "ready"
        ? "Open it in the video studio to adjust anything."
        : slow
          ? "This one is taking a little longer than usual."
          : "Wait here, or choose Finish later. It keeps going either way.";

  return (
    <div className="np-preview" data-production={production.state}>
      <div className="np-preview-frame">
        {production.state === "ready" ? (
          <video className="np-final" src={production.url} controls autoPlay playsInline aria-label="Your video" />
        ) : showPreview && composition ? (
          <Suspense fallback={<div className="np-player-loading" />}>
            <PreviewPlayer composition={composition} media={media} />
          </Suspense>
        ) : (
          <div className="np-produce-card" aria-hidden="true">
            {waiting && <LoaderCircle size={26} className="spin" />}
          </div>
        )}
      </div>
      <div className="np-preview-copy">
        <h1 id="np-title">{title}</h1>
        <p className="np-lead">{lead}</p>
        {waiting && (
          <div
            className="np-progress"
            role="progressbar"
            aria-label="Making your video"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress === null ? undefined : Math.round(progress * 100)}
            data-known={progress === null ? undefined : ""}
          >
            <span style={progress === null ? undefined : { width: `${Math.max(4, Math.round(progress * 100))}%` }} />
          </div>
        )}
        {production.state === "failed" && (
          <button type="button" className="button secondary" onClick={onRetry}>
            <RotateCcw size={14} aria-hidden="true" /> Try again
          </button>
        )}
      </div>
    </div>
  );
}
