import { useState } from "react";
import { CalendarCheck, AlertTriangle, Check } from "lucide-react";
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

export function Review({
  campaign,
  manifest: initial,
  context,
  client,
  onClose,
  onRefresh,
}: {
  campaign: Campaign;
  manifest: ScheduleManifest;
  context: StudioContext;
  client: StudioClient;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [manifest, setManifest] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const stale =
    manifest.campaignRevision !== campaign.revision ||
    manifest.approval === "stale" ||
    manifest.entries.some((entry) => {
      const item = campaign.items.find((item) => item.id === entry.itemId);
      return (
        !item ||
        item.revision !== entry.revision ||
        item.renderRevision === null ||
        item.media?.id !== entry.assetId ||
        item.media?.sha256 !== entry.assetHash
      );
    });
  const blocked =
    stale ||
    manifest.blockers.length > 0 ||
    !manifest.entries.length ||
    context.capabilities.mode === "fixture" ||
    new Date(manifest.expiresAt) <= new Date();
  async function act(action: "approve" | "commit") {
    if (
      blocked ||
      busy ||
      submitted ||
      Date.parse(manifest.expiresAt) <= Date.now()
    )
      return;
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
        setSubmitted(true);
        setMessage(
          `Request ${result.state}. ${result.jobIds.length} jobs returned. Provider acceptance and publication are tracked separately.`,
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
  return (
    <Modal title="Review the exact schedule" wide onClose={onClose}>
      <div className="review-intro">
        <CalendarCheck size={22} />
        <div>
          <strong>{campaign.title}</strong>
          <p>
            {manifest.entries.length} destinations · {campaign.timezone}
          </p>
        </div>
        <span className="status-chip">
          {manifest.approval.replaceAll("_", " ")}
        </span>
      </div>
      {stale && (
        <Notice error>
          The campaign changed after this review was prepared. Close this review
          and prepare a new schedule.
        </Notice>
      )}
      {manifest.blockers.length > 0 && (
        <div className="review-blockers">
          <h3>Before this can be scheduled</h3>
          <ul>
            {manifest.blockers.map((b, i) => (
              <li key={i}>
                <AlertTriangle size={14} />
                {b.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {manifest.entries.map((entry, i) => {
        const item = campaign.items.find((x) => x.id === entry.itemId);
        return (
          <article
            className="review-entry"
            key={`${entry.itemId}-${entry.platform}-${i}`}
          >
            <div className="review-thumbnail">
              {item && (
                <Preview
                  item={item}
                  index={campaign.items.indexOf(item)}
                  brandName={
                    campaign.companyContext?.name ?? context.brand.name
                  }
                  compact
                />
              )}
            </div>
            <div>
              <h3>
                <PlatformIcon platform={entry.platform} />
                {platformNames[entry.platform]}
              </h3>
              <p>
                {context.channels.find((c) => c.id === entry.accountId)
                  ?.displayName ?? entry.accountId}
              </p>
              <time dateTime={entry.scheduledAt}>
                {dateLabel(entry.scheduledAt, entry.timezone, true)} ·{" "}
                {entry.timezone}
              </time>
              <h4>{entry.title}</h4>
              <p className="review-copy">{entry.caption}</p>
              <small>
                {entry.visibility} · AI disclosure{" "}
                {entry.aiDisclosure ? "on" : "off"} · Content v{entry.revision}
              </small>
              <details>
                <summary>Asset verification</summary>
                <code>
                  {entry.assetId}
                  <br />
                  {entry.assetHash}
                </code>
              </details>
            </div>
          </article>
        );
      })}
      <p className="small muted">
        Approval is bound to these assets, copy, accounts, and times. Any change
        requires a new review. Provider processing can delay actual publication.
      </p>
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <footer className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Keep editing
        </button>
        {manifest.approval === "approved" ? (
          <button
            className="button primary"
            disabled={blocked || busy || submitted}
            onClick={() => void act("commit")}
          >
            Submit schedule
          </button>
        ) : (
          <button
            className="button primary"
            disabled={blocked || busy || context.workspace.role !== "owner"}
            onClick={() => void act("approve")}
          >
            <Check size={15} />
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
