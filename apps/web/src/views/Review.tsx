import { useEffect, useState } from "react";
import { ArrowRight, Check, CircleAlert, Clock, Lock } from "lucide-react";
import type {
  Campaign,
  ScheduleManifest,
  StudioContext,
} from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { operationKey } from "../lib/operation-key";
import {
  Modal,
  Notice,
  PlatformIcon,
  Preview,
  dateLabel,
  platformNames,
} from "../components/ui";
import { approvalBlock, blockerScope, blockerText, reviewState, reviewSteps, type ReviewStep } from "./editor/review";
import "../editor.css";

const stepTitle: Record<ReviewStep["id"], string> = {
  claims: "Claims",
  videos: "Videos rendered",
  channels: "Posting times and channels",
  other: "Other checks",
};
const headline = {
  stale: "This review is out of date",
  expired: "This review has expired",
  blocked: "Not ready to schedule",
  ready: "Ready for your approval",
  approved: "Approved · ready to submit",
} as const;

/**
 * The schedule review as a short checklist: what still holds the schedule back, how many drafts each
 * step covers, and the one thing that fixes it. The exact entries and the approve action appear only
 * once the server reports nothing blocking. Approval stays bound to the manifest hash the server sent.
 */
export function Review({
  campaign,
  manifest: initial,
  context,
  client,
  onClose,
  onRefresh,
  onOpenReview,
  onOpenVideo,
  onOpenSchedule,
}: {
  campaign: Campaign;
  /** Where each blocked step's fix happens: the video editor, and the schedule with its channels. */
  onOpenVideo?: () => void;
  onOpenSchedule?: () => void;
  manifest: ScheduleManifest;
  context: StudioContext;
  client: StudioClient;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  /** Opens Details → Review for one draft, so its claims can be fixed or approved. */
  onOpenReview?: (itemId: string) => void;
}) {
  const [manifest, setManifest] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [, setTick] = useState(0);
  // Re-check when the review expires, so the page never offers an approval the server would refuse.
  useEffect(() => {
    const left = Date.parse(manifest.expiresAt) - Date.now();
    if (left <= 0 || left > 2 ** 31 - 1) return;
    const timer = setTimeout(() => setTick((value) => value + 1), left + 50);
    return () => clearTimeout(timer);
  }, [manifest.expiresAt]);
  const state = reviewState(manifest, campaign);
  const steps = reviewSteps(manifest, campaign);
  const approveReason = approvalBlock(state, context);
  const approved = state === "approved";
  const fixture = context.capabilities.mode === "fixture";
  const left = steps.filter((step) => step.done < step.total).length + (approved ? 0 : 1);
  const brand = campaign.companyContext?.name ?? context.brand.name;
  const canSubmit = approved && !fixture && !busy && !submitted;

  async function act(action: "approve" | "commit") {
    if (busy || submitted) return;
    // Re-derived at the moment of the click: stale, expired, blocked and non-owner approvals never leave the page.
    const now = reviewState(manifest, campaign);
    if (action === "approve" && approvalBlock(now, context)) return;
    if (action === "commit" && (now !== "approved" || fixture)) return;
    setBusy(true);
    setError("");
    try {
      const input = {
        manifestId: manifest.id,
        hash: manifest.hash,
        operationKey: await operationKey(context.workspace.id, action, {
          manifestId: manifest.id,
          hash: manifest.hash,
        }),
      };
      if (action === "approve") {
        await client.approveSchedule(input);
        const next = await client.prepareSchedule({
          campaignId: campaign.id,
          expectedRevision: campaign.revision,
          operationKey: crypto.randomUUID(),
        });
        if (next.hash !== manifest.hash)
          throw new Error(
            "The schedule changed. Review the latest manifest before approving.",
          );
        setManifest(next);
        setMessage(
          next.approval === "approved"
            ? "Approval recorded for this exact schedule."
            : "Approval is still awaiting server confirmation.",
        );
      } else {
        const result = await client.commitSchedule(input);
        setSubmitted(result.state);
        setMessage(
          `Request ${result.state}. ${result.jobIds.length} ${result.jobIds.length === 1 ? "job" : "jobs"} returned. Platform acceptance and publication are tracked separately.`,
        );
        await onRefresh();
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The schedule could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }

  const fix = (step: ReviewStep) => {
    if (step.id === "claims") {
      if (!onOpenReview) return null;
      const ids = [...new Set(step.blockers.flatMap((blocker) => blocker.itemIds))].filter((id) => campaign.items.some((item) => item.id === id));
      return (
        <div className="review-fixes">
          {ids.map((id) => (
            <button type="button" className="review-fix" key={id} onClick={() => onOpenReview(id)}>
              {ids.length === 1 ? "Open its review" : `Open “${campaign.items.find((item) => item.id === id)?.title}”`} <ArrowRight size={13} aria-hidden="true" />
            </button>
          ))}
        </div>
      );
    }
    if (step.id === "videos")
      return context.capabilities.canRender ? (
        <button type="button" className="review-fix" onClick={onOpenVideo ?? onClose}>
          Render from your drafts <ArrowRight size={13} aria-hidden="true" />
        </button>
      ) : (
        <div className="review-fixes">
          <span className="review-why"><Lock size={12} aria-hidden="true" />{context.capabilities.renderBlocker ?? "Rendering isn’t connected yet"}</span>
          {onOpenVideo && <button type="button" className="review-fix secondary" onClick={onOpenVideo}>Preview it in the video editor <ArrowRight size={13} aria-hidden="true" /></button>}
        </div>
      );
    if (step.id === "channels")
      return fixture ? (
        <span className="review-why"><Lock size={12} aria-hidden="true" />Publishing isn’t connected here</span>
      ) : (
        <button type="button" className="review-fix" onClick={onOpenSchedule ?? onClose}>
          Set times and channels <ArrowRight size={13} aria-hidden="true" />
        </button>
      );
    return null;
  };

  return (
    <Modal title="Review schedule" wide onClose={onClose}>
      <div className="review-sheet">
        <header className="review-status" data-state={submitted ? "submitted" : state}>
          <span className="review-status-mark" aria-hidden="true">
            {approved || submitted ? <Check size={18} strokeWidth={2.25} /> : state === "expired" ? <Clock size={18} /> : <CircleAlert size={18} />}
          </span>
          <div>
            <h3>{submitted ? (submitted === "blocked" ? "Not accepted for scheduling" : "Sent for scheduling") : headline[state]}</h3>
            <p>
              {campaign.title}
              {state === "blocked" && ` · ${left} ${left === 1 ? "step" : "steps"} left`}
              {(state === "ready" || approved) && ` · ${manifest.entries.length} ${manifest.entries.length === 1 ? "post" : "posts"} · ${campaign.timezone}`}
            </p>
          </div>
        </header>

        {(state === "stale" || state === "expired") && !submitted ? (
          <div className="review-restart">
            <p id="approve-reason">
              {state === "stale"
                ? "The campaign changed after this review was prepared, so it can’t be approved."
                : "Reviews are valid for a short time so approval always matches the latest campaign."}
            </p>
            <button type="button" className="button secondary" onClick={onClose}>
              Close and prepare a new review
            </button>
          </div>
        ) : (
          <ol className="review-steps">
            {steps.map((step) => {
              const met = step.done === step.total && !step.blockers.length;
              return (
                <li className="review-step" data-done={met} key={step.id}>
                  <span className="review-mark" aria-hidden="true">{met && <Check size={12} strokeWidth={2.75} />}</span>
                  <div className="review-step-body">
                    <div className="review-step-head">
                      <strong>{stepTitle[step.id]}</strong>
                      {step.id !== "other" && (
                        <span className="review-count">
                          {step.done} of {step.total}
                          <span className="sr-only">{met ? ", done" : ", not done"}</span>
                        </span>
                      )}
                    </div>
                    {!met && (
                      <>
                        <ul className="review-blockers">
                          {step.blockers.map((blocker) => (
                            <li key={blocker.message}>
                              <span>{blockerText(blocker.message)}</span>
                              <small className="blocker-scope">{blockerScope(blocker.itemIds, campaign)}</small>
                            </li>
                          ))}
                        </ul>
                        {fix(step)}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
            <li className="review-step" data-done={approved}>
              <span className="review-mark" aria-hidden="true">{approved && <Check size={12} strokeWidth={2.75} />}</span>
              <div className="review-step-body">
                <div className="review-step-head">
                  <strong>Your approval</strong>
                  <span className="review-count">
                    {approved ? "Approved" : "Owner only"}
                    <span className="sr-only">{approved ? ", done" : ", not done"}</span>
                  </span>
                </div>
                {!approved && approveReason && <p className="review-step-note" id="approve-reason">{approveReason}</p>}
              </div>
            </li>
          </ol>
        )}

        {(state === "ready" || approved) && (
          <section className="review-entries" aria-label="Exactly what will be scheduled">
            {manifest.entries.map((entry, index) => {
              const item = campaign.items.find((candidate) => candidate.id === entry.itemId);
              return (
                <article className="review-entry-row" key={`${entry.itemId}-${entry.platform}-${index}`}>
                  <div className="review-entry-thumb">
                    {item && <Preview item={item} index={campaign.items.indexOf(item)} brandName={brand} compact passive />}
                  </div>
                  <div className="review-entry-main">
                    <strong>{item?.title ?? entry.title}</strong>
                    <span className="review-entry-channel">
                      <PlatformIcon platform={entry.platform} />
                      {platformNames[entry.platform]} · {context.channels.find((channel) => channel.id === entry.accountId)?.displayName ?? entry.accountId}
                    </span>
                    <details>
                      <summary>Caption and checks</summary>
                      {entry.title && <p className="review-entry-title">{entry.title}</p>}
                      <p className="review-copy">{entry.caption}</p>
                      <small>
                        {entry.visibility} · AI disclosure {entry.aiDisclosure ? "on" : "off"} · Version {entry.revision}
                      </small>
                      <code>{entry.assetId}<br />{entry.assetHash}</code>
                    </details>
                  </div>
                  <time dateTime={entry.scheduledAt}>
                    {dateLabel(entry.scheduledAt, entry.timezone)}
                    {entry.timezone !== campaign.timezone && <small>{entry.timezone}</small>}
                  </time>
                </article>
              );
            })}
          </section>
        )}

        {error && <Notice error>{error}</Notice>}
        {message && <p className="review-message" role="status">{message}</p>}
        <p className="review-footnote">
          Approval covers exactly these videos, captions, accounts and times; any change needs a new review. Platforms may post a little after the set time.
        </p>
      </div>
      <footer className="modal-actions review-actions">
        <button className="button secondary" onClick={onClose}>
          Keep editing
        </button>
        {approved ? (
          <button
            className="button primary"
            disabled={!canSubmit}
            onClick={() => void act("commit")}
          >
            {busy ? "Submitting…" : "Submit schedule"}
          </button>
        ) : (
          <button
            className="button primary"
            disabled={Boolean(approveReason) || busy}
            aria-describedby={approveReason ? "approve-reason" : undefined}
            onClick={() => void act("approve")}
          >
            <Check size={15} aria-hidden="true" />
            {busy ? "Confirming…" : "Approve exact schedule"}
          </button>
        )}
      </footer>
    </Modal>
  );
}

export function Grant({
  campaign,
  context,
  client,
  onClose,
}: {
  campaign: Campaign;
  context: StudioContext;
  client: StudioClient;
  onClose: () => void;
}) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [expiresAt] = useState(() =>
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  );
  const accountIds = [
    ...new Set(
      campaign.items.flatMap((i) =>
        i.targets.map((t) => t.accountId).filter((x): x is string => !!x),
      ),
    ),
  ];
  const avatarIds = [
    ...new Set(
      campaign.items.map((i) => i.avatarId).filter((x): x is string => !!x),
    ),
  ];
  const targets = campaign.items.flatMap((i) => i.targets);
  const instants = targets
    .map((t) => new Date(t.scheduledAt).getTime())
    .sort((a, b) => a - b);
  async function authorize() {
    setBusy(true);
    try {
      const result = await client.createGrant({
        campaignId: campaign.id,
        campaignRevision: campaign.revision,
        operationKey: await operationKey(context.workspace.id, "create-grant", {
          campaignId: campaign.id,
          revision: campaign.revision,
          accountIds,
          avatarIds,
          expiresAt,
        }),
        accountIds,
        avatarIds,
        maximumItems: Math.min(3, campaign.items.length),
        maximumPosts: Math.min(9, targets.length),
        maximumRenderSeconds: 180,
        expiresAt,
        windowStart: new Date(instants[0]).toISOString(),
        windowEnd: new Date(instants.at(-1)!).toISOString(),
        acknowledgesFuturePublication: true,
      });
      setSuccess(
        `Grant ${result.id} created. New submissions authorized until ${dateLabel(result.expiresAt, campaign.timezone)}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authorization failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Authorize one campaign run" onClose={onClose}>
      <p>
        Allow future generated content from <strong>{campaign.title}</strong> to
        publish without reviewing every final video.
      </p>
      <dl className="grant-facts">
        <dt>Content boundary</dt>
        <dd>This campaign and its current plan, version {campaign.revision}</dd>
        <dt>Generation cap</dt>
        <dd>
          Up to 3 videos, 180 rendered seconds. Failed paid attempts count.
        </dd>
        <dt>Publication cap</dt>
        <dd>
          Up to {Math.min(9, targets.length)} posts to the selected accounts
        </dd>
        <dt>Submission authorization</dt>
        <dd>Expires one hour after you authorize</dd>
        <dt>Cost</dt>
        <dd>
          A dollar cap is not verified. Limits use measurable production units.
        </dd>
      </dl>
      <div className="grant-targets">
        {targets.map((t, i) => (
          <p key={i}>
            <PlatformIcon platform={t.platform} />
            {context.channels.find((c) => c.id === t.accountId)?.displayName ??
              "Account not connected"}{" "}
            · {dateLabel(t.scheduledAt, t.timezone)}
          </p>
        ))}
      </div>
      <Notice>
        Revocation stops new submissions. Already accepted schedules need
        explicit cancellation; they are not automatically removed at expiry.
      </Notice>
      {!context.capabilities.canCreateGrant && (
        <Notice>
          The backend has not enabled bounded-run grants. Review-first remains
          the default.
        </Notice>
      )}
      <label className="check-label consent">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        I authorize publication of future generated content within these limits
        without reviewing each final video.
      </label>
      {error && <Notice error>{error}</Notice>}
      {success && <Notice>{success}</Notice>}
      <footer className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Keep review-first
        </button>
        <button
          className="button primary"
          disabled={
            !consent ||
            busy ||
            !!success ||
            !context.capabilities.canCreateGrant ||
            !accountIds.length ||
            !avatarIds.length ||
            context.workspace.role !== "owner"
          }
          onClick={() => void authorize()}
        >
          Authorize this run
        </button>
      </footer>
    </Modal>
  );
}
