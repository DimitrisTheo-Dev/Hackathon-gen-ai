import { REVIEW_BLOCKER_PREFIX, type Campaign, type ScheduleManifest, type StudioContext } from "@castroom/contracts";

/**
 * The schedule review as a checklist. The server's blockers stay the authority: this only sorts their
 * wording into the step a person can act on, and counts how many drafts each step still holds back.
 */
export type ReviewStepId = "claims" | "videos" | "channels" | "other";
export type BlockerGroup = { message: string; itemIds: string[] };
export type ReviewStep = { id: ReviewStepId; done: number; total: number; blockers: BlockerGroup[] };
export type ReviewState = "stale" | "expired" | "blocked" | "ready" | "approved";

/** Which step a server blocker belongs to. Unknown wording is kept, in its own step, never dropped. */
export function blockerStep(message: string): ReviewStepId {
  // The content-review gate names itself; its wording may mention a video, so it is matched first.
  if (message.startsWith(REVIEW_BLOCKER_PREFIX)) return "claims";
  if (/\b(video|render(?:ed|ing)?|presenter)\b/i.test(message)) return "videos";
  if (/\b(destination|channel|account|publish(?:ing)?|time|copy|caption|schedul\w*|youtube|instagram|tiktok)\b/i.test(message)) return "channels";
  return "other";
}

/** True when the review no longer describes the campaign: a newer revision, a changed video or a server-side stale flag. */
export function manifestStale(manifest: ScheduleManifest, campaign: Campaign): boolean {
  return (
    manifest.campaignRevision !== campaign.revision ||
    manifest.approval === "stale" ||
    manifest.entries.some((entry) => {
      const item = campaign.items.find((candidate) => candidate.id === entry.itemId);
      return (
        !item ||
        item.revision !== entry.revision ||
        item.renderRevision === null ||
        item.media?.id !== entry.assetId ||
        item.media?.sha256 !== entry.assetHash
      );
    })
  );
}

export function reviewSteps(manifest: ScheduleManifest, campaign: Campaign): ReviewStep[] {
  const total = campaign.items.length;
  const groups: Record<ReviewStepId, Map<string, Set<string>>> = { claims: new Map(), videos: new Map(), channels: new Map(), other: new Map() };
  for (const blocker of manifest.blockers) {
    const step = groups[blockerStep(blocker.message)];
    const ids = step.get(blocker.message) ?? new Set<string>();
    ids.add(blocker.itemId);
    step.set(blocker.message, ids);
  }
  const step = (id: ReviewStepId): ReviewStep => {
    const held = new Set([...groups[id].values()].flatMap((ids) => [...ids]));
    return {
      id,
      done: Math.max(0, total - held.size),
      total,
      blockers: [...groups[id]].map(([message, ids]) => ({ message, itemIds: [...ids] })),
    };
  };
  // Claims come first, and only when the server holds a draft back for them: a fixed script means a new render,
  // and a list with nothing to say about claims must not read as "claims checked".
  return [...(groups.claims.size ? [step("claims")] : []), step("videos"), step("channels"), ...(groups.other.size ? [step("other")] : [])];
}

/** A blocker's words as the checklist shows them: under "Claims", the prefix that filed it there is not repeated. */
export function blockerText(message: string): string {
  return message.startsWith(REVIEW_BLOCKER_PREFIX) ? message.slice(REVIEW_BLOCKER_PREFIX.length).trim() || message : message;
}

export function reviewState(manifest: ScheduleManifest, campaign: Campaign, now = Date.now()): ReviewState {
  if (manifestStale(manifest, campaign)) return "stale";
  if (Date.parse(manifest.expiresAt) <= now) return "expired";
  if (manifest.blockers.length > 0 || manifest.entries.length === 0) return "blocked";
  return manifest.approval === "approved" ? "approved" : "ready";
}

/** Why the approve action is unavailable, or "" when a person may approve this exact schedule now. */
export function approvalBlock(state: ReviewState, context: StudioContext): string {
  if (state === "stale") return "This review is out of date. Close it and prepare a new one.";
  if (state === "expired") return "This review expired. Close it and prepare a new one.";
  if (state === "blocked") return "Finish the steps above first.";
  if (context.capabilities.mode === "fixture") return "Local workspaces can’t approve a schedule.";
  if (context.principal.kind !== "human") return "Approval needs a person; an agent can’t approve.";
  if (context.workspace.role !== "owner") return "Only the workspace owner can approve.";
  return "";
}

/** "all 3 drafts" or the titles a blocker applies to, for the line under its message. */
export function blockerScope(itemIds: string[], campaign: Campaign): string {
  if (itemIds.length === campaign.items.length && itemIds.length > 1) return `All ${itemIds.length} drafts`;
  return itemIds.map((id) => campaign.items.find((item) => item.id === id)?.title ?? id).join(", ");
}
