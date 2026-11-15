import { useState } from "react";
import type { Composition, StudioContext } from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { operationKey } from "../lib/operation-key";
import { savedComposition, type Presenter } from "./model";

/**
 * Create, the last action of New project: the video starts being made, then the studio opens where it is followed.
 *   • a timeline (a person's own take, a persona, or no presenter): the timeline is saved and an MP4 render is queued.
 *     The engine reads the script aloud when nobody speaks in it: the persona's own voice, else a stock voice.
 *   • a stock AI avatar, where the avatar renderer is connected: the speaking video is rendered. Where it is not, the
 *     video is made as a timeline instead, read by a stock voice.
 * Nothing is made where no renderer is connected; the draft is saved and the project opens.
 * Keys come from what is being made, so pressing Create twice for the same video queues it once.
 */
export type Made = { route: "timeline" | "avatar" | "none"; openVideo: boolean };

export async function produce({
  client,
  context,
  project,
  mode,
  composition,
  persona,
}: {
  client: StudioClient;
  context: StudioContext;
  project: { campaignId: string; itemId: string; revision: number };
  mode: Presenter["mode"] | "none";
  composition: Composition | null;
  /** The persona chosen as the face: its voice reads the script and its photo is the picture. */
  persona: { personaId: string; lookId: string | null } | null;
}): Promise<Made> {
  const { capabilities, workspace } = context;
  if (mode === "avatar" && capabilities.canRender && capabilities.mode !== "fixture") {
    const payload = { campaignId: project.campaignId, itemIds: [project.itemId], expectedRevisions: { [project.itemId]: project.revision } };
    const operation = await client.renderContent({ ...payload, operationKey: await operationKey(workspace.id, "render_content", payload) });
    if (operation.state === "blocked") throw new Error("The video could not be started. Open it in the studio to see why.");
    // The canvas follows avatar renders.
    return { route: "avatar", openVideo: false };
  }
  const renders = capabilities.mode !== "fixture" && capabilities.canRenderTimeline;
  if (mode === "avatar" && !renders) return { route: "none", openVideo: false };
  if (!composition) throw new Error("This draft could not be turned into a video. Open it in the video studio.");
  // The timeline is saved either way, so a person's own take is in place when they open the video studio.
  const timeline = savedComposition(composition);
  const document = await client.getComposition(project.itemId);
  const saving = { contentId: project.itemId, expectedRevision: document.revision, composition: timeline };
  const saved = await client.saveComposition({ ...saving, operationKey: await operationKey(workspace.id, "save_composition", saving) });
  if (!renders) return { route: "none", openVideo: mode === "camera" || mode === "voice" };
  const queue = { contentId: project.itemId, expectedRevision: saved.revision, personaId: persona?.personaId ?? null, lookId: persona?.lookId ?? null };
  await client.queueRender({ ...queue, operationKey: await operationKey(workspace.id, "queue_reel_render", queue) });
  // The video studio shows the render's progress and plays the result.
  return { route: "timeline", openVideo: true };
}

/** Whether the rough preview is shown. Off unless the person turns it on; kept per browser as a viewing preference. */
export function usePreviewShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem("faceful.newProject.preview") === "shown";
    } catch {
      return false;
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
