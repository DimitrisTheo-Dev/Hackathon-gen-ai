import { Check, CircleAlert, CircleQuestionMark, CircleX, HeartPulse, Info, Landmark, Lightbulb, TriangleAlert, UserRoundSearch, type LucideIcon } from "lucide-react";
import { blockingCount, type ClaimStatus, type ContentItem, type ContentReview, type RegulatedDomain, type ReviewSeverity } from "@castroom/contracts";
import "./review.css";

/**
 * The words the studio uses for products and content reviews, in one place so the brand kit, Details and the
 * video studio say the same thing. Status is always a word and an icon, never colour alone. Nothing here says
 * "verified", "fact-checked" or "accurate": a review finds wording that needs a source, an expert or a fix.
 */

export const DOMAIN_LABEL: Record<RegulatedDomain, string> = { general: "General", health: "Health", finance: "Finance" };
const DOMAIN_ICON: Record<Exclude<RegulatedDomain, "general">, LucideIcon> = { health: HeartPulse, finance: Landmark };

/** A quiet chip for regulated products and scripts. General shows nothing. */
export function DomainChip({ domain }: { domain: RegulatedDomain }) {
  if (domain === "general") return null;
  const Icon = DOMAIN_ICON[domain];
  return (
    <span className="domain-chip" data-domain={domain}>
      <Icon size={12} strokeWidth={2.25} aria-hidden="true" />
      {DOMAIN_LABEL[domain]}
    </span>
  );
}

export const CLAIM_STATUS: Record<ClaimStatus, { label: string; icon: LucideIcon }> = {
  supported: { label: "Matches a fact", icon: Check },
  contradicted: { label: "Contradicts a fact", icon: CircleX },
  unsupported: { label: "No approved fact", icon: CircleQuestionMark },
  risky_wording: { label: "Risky wording", icon: TriangleAlert },
  needs_expert: { label: "Needs an expert", icon: UserRoundSearch },
};

/** What a severity asks of a person, as a word beside the item. Info needs no word. */
export const SEVERITY_WORD: Record<ReviewSeverity, string> = { blocking: "To fix", warning: "Advice", info: "" };

/** The tone of a status chip follows the severity: blocking is red ink, advice amber, a matching fact green. */
export function ClaimChip({ status, severity }: { status: ClaimStatus; severity: ReviewSeverity }) {
  const { label, icon: Icon } = CLAIM_STATUS[status];
  return (
    <span className="claim-chip" data-tone={severity === "blocking" ? "danger" : severity === "warning" ? "warning" : status === "supported" ? "positive" : "neutral"}>
      <Icon size={12} strokeWidth={2.25} aria-hidden="true" />
      {label}
    </span>
  );
}

const SEVERITY_ICON: Record<ReviewSeverity, LucideIcon> = { blocking: CircleAlert, warning: Lightbulb, info: Info };
/** Findings carry no claim status, so their chip names what they ask of a person: To fix, Advice or Note. */
export function SeverityChip({ severity }: { severity: ReviewSeverity }) {
  const Icon = SEVERITY_ICON[severity];
  return (
    <span className="claim-chip" data-tone={severity === "blocking" ? "danger" : severity === "warning" ? "warning" : "neutral"}>
      <Icon size={12} strokeWidth={2.25} aria-hidden="true" />
      {SEVERITY_WORD[severity] || "Note"}
    </span>
  );
}

/** A review describes one saved version; any later version makes it out of date. */
export const reviewIsCurrent = (review: ContentReview | null, item: Pick<ContentItem, "revision">) => Boolean(review && review.itemRevision === item.revision);

/** The short value on the Details row: Not reviewed, Passed, N to fix, Needs approval, Approved · name, or Out of date. */
export function reviewSummary(review: ContentReview | null, item: Pick<ContentItem, "revision">): { text: string; tone: "none" | "attention" | "positive" } {
  if (!review) return { text: "Not reviewed", tone: "none" };
  if (!reviewIsCurrent(review, item)) return { text: "Out of date", tone: "attention" };
  if (review.status === "approved") return { text: `Approved · ${review.approval?.by ?? "a person"}`, tone: "positive" };
  if (review.status === "needs_changes") return { text: `${blockingCount(review)} to fix`, tone: "attention" };
  if (review.status === "needs_approval") return { text: "Needs approval", tone: "attention" };
  return { text: "Passed", tone: "none" };
}

/** `12.4` → `0:12.4`, the timeline's own notation. */
export function timecode(seconds: number) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const rest = Math.max(0, seconds) - minutes * 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}
