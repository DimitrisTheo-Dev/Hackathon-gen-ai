import { Check, Lock } from "lucide-react";
import type { Campaign } from "@castroom/contracts";

type Step = { id: "write" | "video" | "schedule" | "approve"; label: string; detail: string; done: boolean; blocked?: boolean; go: () => void };

/**
 * The path from an idea to a post, in the order the studio works: write the drafts, make the video, set times and
 * channels, then approve. Each step says where the project stands, worded only from what the server reports, and
 * one click goes to where that step is done. It is a map, not a gate: every step stays reachable.
 */
export function FlowRail({ campaign, view, canRender, renderBlocker, onCanvas, onVideo, onSchedule, onReview }: {
  campaign: Campaign;
  view: string;
  canRender: boolean;
  renderBlocker: string | null;
  onCanvas: () => void;
  onVideo: () => void;
  onSchedule: () => void;
  onReview: () => void;
}) {
  const items = campaign.items;
  const total = items.length;
  const rendered = items.filter((item) => item.media).length;
  const timed = items.filter((item) => item.targets.length > 0).length;
  const states = items.flatMap((item) => item.targets.map((target) => target.state));
  const published = states.filter((state) => state === "published").length;
  const accepted = states.filter((state) => state === "accepted" || state === "queued").length;
  const steps: Step[] = [
    { id: "write", label: "Write", detail: total ? `${total} ${total === 1 ? "draft" : "drafts"}` : "No drafts yet", done: total > 0, go: onCanvas },
    {
      id: "video",
      label: "Video",
      detail: !canRender && rendered === 0 ? "Not connected yet" : `${rendered} of ${total} rendered`,
      done: total > 0 && rendered === total,
      blocked: !canRender && rendered < total,
      go: onVideo,
    },
    { id: "schedule", label: "Schedule", detail: `${timed} of ${total} have a time`, done: total > 0 && timed === total, go: onSchedule },
    {
      id: "approve",
      label: "Approve",
      detail: published ? `${published} published` : accepted ? `${accepted} scheduled` : "Needs your approval",
      done: published + accepted > 0,
      go: onReview,
    },
  ];
  const current = steps.find((step) => !step.done)?.id ?? null;
  const here = view === "canvas" ? "write" : view === "video" ? "video" : view === "schedule" ? "schedule" : null;
  return (
    <nav className="flow-rail" aria-label="From draft to post">
      <ol>
        {steps.map((step, index) => (
          <li key={step.id} data-done={step.done || undefined} data-current={current === step.id || undefined} data-here={here === step.id || undefined}>
            <button type="button" onClick={step.go} aria-current={here === step.id ? "step" : undefined} title={step.blocked && renderBlocker ? renderBlocker : undefined}>
              <span className="flow-node" aria-hidden="true">{step.done ? <Check size={12} strokeWidth={2.75} /> : index + 1}</span>
              <span className="flow-text">
                <strong>{step.label}</strong>
                <small>{step.blocked && <Lock size={10} aria-hidden="true" />}{step.detail}</small>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
