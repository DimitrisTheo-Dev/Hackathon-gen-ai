import type { Campaign, ContentItem } from "@castroom/contracts";

export type ItemBadge = {
  label: "Draft" | "Queued" | "Rendering" | "Ready for review" | "Scheduled" | "Published" | "Failed";
  tone: "draft" | "queued" | "rendering" | "ready" | "scheduled" | "published" | "failed";
};

/**
 * One badge per item, derived only from states the engine has reported.
 * A requested time is still a draft; "Scheduled" needs an accepted publish job and
 * "Published" needs provider evidence. A storyboard without a current video is never "Ready".
 */
export function itemBadge(item: ContentItem, jobs: Campaign["jobs"] = []): ItemBadge {
  if (item.targets.some((target) => target.state === "published")) return { label: "Published", tone: "published" };
  if (item.targets.some((target) => target.state === "queued" || target.state === "accepted")) return { label: "Scheduled", tone: "scheduled" };
  const active = jobs.find((job) => job.itemId === item.id && job.stage !== "publish" && ["queued", "running", "cancel_requested"].includes(job.state));
  if (item.status === "rendering" || active?.state === "running" || active?.state === "cancel_requested") return { label: "Rendering", tone: "rendering" };
  if (item.status === "queued" || active?.state === "queued") return { label: "Queued", tone: "queued" };
  if (item.status === "failed") return { label: "Failed", tone: "failed" };
  if ((item.status === "ready" && item.media && item.renderRevision !== null) || item.status === "needs_review") return { label: "Ready for review", tone: "ready" };
  return { label: "Draft", tone: "draft" };
}

/** The most recent failed render for this item, if the item is still showing that failure. */
export function failedRender(item: ContentItem, jobs: Campaign["jobs"] = []) {
  if (item.status !== "failed") return null;
  return jobs.filter((job) => job.itemId === item.id && job.stage !== "publish" && job.state === "failed").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}
