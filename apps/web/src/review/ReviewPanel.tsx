import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from "react";
import { Check, Minus } from "lucide-react";
import {
  applySuggestion,
  blockingCount,
  isRegulated,
  type ApproveReviewInput,
  type ContentItem,
  type ContentReview,
  type ReviewClaim,
  type ReviewFinding,
  type ReviewSeverity,
  type StudioContext,
} from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { Notice } from "../components/ui";
import { ClaimChip, DOMAIN_LABEL, DomainChip, SEVERITY_WORD, SeverityChip, reviewIsCurrent, timecode } from "./vocabulary";

export type ReviewApi = Pick<StudioClient, "getReview" | "reviewContent" | "approveReview">;

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** The latest review of one item, and the two things a person can do with it: check again, and approve. */
export function useContentReview(api: ReviewApi | undefined, itemId: string) {
  const [review, setReview] = useState<ContentReview | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!api) return;
    let live = true;
    // A workspace that has never been reviewed (or an engine without reviews yet) simply shows "Not reviewed".
    void api.getReview(itemId).then((next) => live && setReview(next)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, itemId]);
  async function check() {
    if (!api || checking) return;
    setChecking(true);
    setError("");
    setAnnouncement("");
    try {
      const next = await api.reviewContent({ itemId, operationKey: crypto.randomUUID() });
      setReview(next);
      const blocking = blockingCount(next);
      setAnnouncement(
        `Check finished. ${blocking ? `${blocking} to fix.` : next.status === "needs_approval" ? "It needs a named approval." : "Nothing to fix."}`,
      );
    } catch (failure) {
      setError(messageOf(failure, "The check didn’t run. Check your connection and try again."));
    } finally {
      setChecking(false);
    }
  }
  async function approve(input: ApproveReviewInput) {
    if (!api) throw new Error("Approval isn’t available in this workspace.");
    return api.approveReview(input);
  }
  return { review, setReview, checking, error, announcement, setAnnouncement, check, approve, available: Boolean(api) };
}
export type ContentReviewState = ReturnType<typeof useContentReview>;

const CHECKED: Array<{ key: keyof ContentReview["checked"]; label: string }> = [
  { key: "claims", label: "Claims in the script" },
  { key: "timeline", label: "Captions, labels and what’s on screen" },
  { key: "transcript", label: "The voice against the script" },
  { key: "renderedVideo", label: "The rendered video" },
];
const ORDER: Record<ReviewSeverity, number> = { blocking: 0, warning: 1, info: 2 };
const APPROVERS = ["owner", "admin", "reviewer"];
const CREDENTIAL_EXAMPLE = { general: "", health: "MD, cardiologist", finance: "Certified financial adviser" } as const;

/**
 * Details → Review: what a check of the saved script found, in three groups (claims; voice and captions; on screen),
 * what it looked at and what it did not, and a named human approval. It never says "verified".
 */
export function ReviewPanel({
  item,
  script,
  dirty,
  editable,
  offline,
  context,
  products,
  state,
  onScript,
  onUndo,
}: {
  /** The saved item: a review describes one saved version. */
  item: ContentItem;
  /** The script as it stands in the editor, unsaved edits included. */
  script: string;
  dirty: boolean;
  editable: boolean;
  offline: boolean;
  context: StudioContext;
  products: StudioContext["products"];
  state: ContentReviewState;
  /** Replaces the script through the editor's own edit path, so Undo and history work. */
  onScript: (next: string) => void;
  onUndo: () => void;
}) {
  const id = useId();
  const { review, checking, error, check } = state;
  const [applied, setApplied] = useState<{ claimId: string; script: string } | null>(null);
  const current = reviewIsCurrent(review, item);
  const checkReason = dirty ? "Save your edits first. The check reads the saved script." : offline ? "Reconnect to run a check." : "";
  const claims = [...(review?.claims ?? [])].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const notes = review?.notes ?? [];
  // A finding that only repeats a note ("No word timings yet…") is said once, in What was checked.
  const findings = (pass: ReviewFinding["pass"]) =>
    [...(review?.findings ?? [])].filter((finding) => finding.pass === pass && !(finding.severity === "info" && notes.includes(finding.message))).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const delivery = findings("delivery");
  const visuals = findings("visuals");
  const productName = (productId: string | null) => products.find((product) => product.id === productId)?.name ?? null;
  const checkedAt = review ? new Intl.DateTimeFormat("en-GB", { timeZone: context.workspace.timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(review.createdAt)) : "";

  const panel = useRef<HTMLDivElement>(null);
  /** The button that replaced the one just pressed takes focus, without scrolling, so focus never falls out of the panel. */
  const focusSoon = (selector: string) => requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true }));
  function useWording(claim: ReviewClaim) {
    const next = applySuggestion(script, claim);
    if (!next || !editable) return;
    onScript(next);
    setApplied({ claimId: claim.id, script: next });
    focusSoon(`[data-undo="${claim.id}"]`);
  }

  const claimRow = (claim: ReviewClaim) => {
    const replaced = applied?.claimId === claim.id && script === applied.script;
    const usable = Boolean(claim.suggestion && applySuggestion(script, claim));
    const sourceLabel = claim.source?.type === "product_fact" ? `Approved fact${productName(claim.source.id) ? ` · ${productName(claim.source.id)}` : ""}` : claim.source?.type === "source" ? "Source" : "Your brand kit";
    return (
      <li className="cr-item" key={claim.id}>
        <div className="cr-item-head">
          <ClaimChip status={claim.status} severity={claim.severity} />
          {SEVERITY_WORD[claim.severity] && <span className="cr-severity" data-severity={claim.severity}>{SEVERITY_WORD[claim.severity]}</span>}
        </div>
        <p className="cr-quote">“{claim.quote}”</p>
        <p className="cr-note">{claim.note}</p>
        {claim.source && !claim.note.includes(claim.source.quote) && (
          <p className="cr-source">
            <span>{sourceLabel}</span>“{claim.source.quote}”
          </p>
        )}
        {claim.suggestion && (
          <div className="cr-suggest">
            <span className="cr-suggest-label">Suggested wording</span>
            <p>“{claim.suggestion}”</p>
            {replaced ? (
              <p className="cr-applied">
                <Check size={13} strokeWidth={2.25} aria-hidden="true" />
                <span>Replaced in the script. Save to keep it.</span>
                <button
                  type="button"
                  className="text-button"
                  data-undo={claim.id}
                  onClick={() => {
                    onUndo();
                    setApplied(null);
                    focusSoon(`[data-use="${claim.id}"]`);
                  }}
                >
                  Undo
                </button>
              </p>
            ) : editable ? (
              <>
                <button type="button" className="button secondary cr-use" data-use={claim.id} disabled={!usable} aria-describedby={!usable ? `${id}-${claim.id}-why` : undefined} onClick={() => useWording(claim)}>
                  Use this wording
                </button>
                {!usable && (
                  <small className="cr-why" id={`${id}-${claim.id}-why`}>
                    This sentence is no longer in the script.
                  </small>
                )}
              </>
            ) : null}
          </div>
        )}
      </li>
    );
  };
  const findingRow = (finding: ReviewFinding) => (
    <li className="cr-item" key={finding.id}>
      <div className="cr-item-head">
        <SeverityChip severity={finding.severity} />
        {finding.at !== null && (
          <span className="cr-time">
            <span className="sr-only">At </span>
            {timecode(finding.at)}
          </span>
        )}
      </div>
      <p className="cr-message">{finding.message}</p>
    </li>
  );
  const group = (key: string, title: string, rows: ReactElement[], checked: boolean, none: string) => (
    <section className="cr-group" aria-labelledby={`${id}-${key}`}>
      <h4 id={`${id}-${key}`}>
        {title}
        {checked && rows.length > 0 && <span className="cr-count">{rows.length}</span>}
      </h4>
      {!checked ? <p className="cr-none">Not checked this time.</p> : rows.length ? <ol className="cr-list">{rows}</ol> : <p className="cr-none">{none}</p>}
    </section>
  );

  return (
    <div className="cr" ref={panel} aria-busy={checking || undefined}>
      {/* One button element in every state: it keeps focus while it runs and when its label changes. */}
      <div className="cr-head" data-first={!review || undefined}>
        {review ? (
          <p className="cr-meta">
            <DomainChip domain={review.domain} />
            <span>Checked {checkedAt}</span>
          </p>
        ) : (
          <p className="cr-lead">Checks the saved script’s claims against your approved facts, the voice and captions against the script, and what’s on screen.</p>
        )}
        <button
          type="button"
          className={`button ${!review || !current ? "primary" : "secondary"} cr-check`}
          disabled={Boolean(checkReason) || !state.available}
          aria-disabled={checking || undefined}
          aria-describedby={checkReason ? `${id}-why` : undefined}
          onClick={() => void check()}
        >
          {checking ? "Checking…" : review ? "Check again" : "Check this draft"}
        </button>
      </div>
      {review && !current && <p className="cr-stale">The script changed after this review. Check it again before approving or scheduling.</p>}
      {checkReason && (
        <p className="cr-why" id={`${id}-why`}>
          {checkReason}
        </p>
      )}
      {error && <Notice error>{error}</Notice>}
      <p className="sr-only" role="status">
        {state.announcement}
      </p>
      {review && (
        <>
          {group(
            "claims",
            "Claims",
            claims.map(claimRow),
            review.checked.claims,
            "The script makes no claims that need a fact or a source.",
          )}
          {group("delivery", "Voice & captions", delivery.map(findingRow), review.checked.timeline || review.checked.transcript, "Nothing came up.")}
          {group("visuals", "On screen", visuals.map(findingRow), review.checked.timeline, "Nothing came up.")}
          <section className="cr-checked" aria-labelledby={`${id}-checked`}>
            <h4 id={`${id}-checked`}>What was checked</h4>
            <ul>
              {CHECKED.map(({ key, label }) => (
                <li key={key} data-checked={review.checked[key] || undefined}>
                  {review.checked[key] ? <Check size={13} strokeWidth={2.25} aria-hidden="true" /> : <Minus size={13} aria-hidden="true" />}
                  <span>
                    {label}
                    <span className="sr-only">{review.checked[key] ? ": checked" : ": not checked"}</span>
                  </span>
                </li>
              ))}
            </ul>
            {notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
            <p>
              {review.mode === "basic"
                ? "Checked against your approved facts and wording rules, not by AI."
                : "An AI model compared the claims with your approved facts and sources. It can miss things; a person decides."}
            </p>
          </section>
          <Approval key={review.id} review={review} current={current} dirty={dirty} offline={offline} context={context} state={state} whyId={checkReason ? `${id}-why` : undefined} />
        </>
      )}
    </div>
  );
}

function Approval({
  review,
  current,
  dirty,
  offline,
  context,
  state,
  whyId,
}: {
  review: ContentReview;
  current: boolean;
  dirty: boolean;
  offline: boolean;
  context: StudioContext;
  state: ContentReviewState;
  whyId?: string;
}) {
  const [by, setBy] = useState("");
  const [credential, setCredential] = useState("");
  const [note, setNote] = useState("");
  const [problems, setProblems] = useState<{ by?: string; credential?: string; note?: string }>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const done = useRef<HTMLParagraphElement>(null);
  const approvedHere = useRef(false);
  const regulated = isRegulated(review.domain);
  const blocking = blockingCount(review);
  useEffect(() => {
    // The form that held focus is gone; the confirmation that replaced it takes focus, without moving the page.
    if (review.approval && approvedHere.current) done.current?.focus({ preventScroll: true });
  }, [review.approval]);
  if (review.approval) {
    const at = new Intl.DateTimeFormat("en-GB", { timeZone: context.workspace.timezone, day: "numeric", month: "short", year: "numeric" }).format(new Date(review.approval.at));
    return (
      <section className="cr-approve is-done" aria-label="Approval">
        <p className="cr-approved" ref={done} tabIndex={-1}>
          <span className="cr-approved-mark" aria-hidden="true">
            <Check size={13} strokeWidth={2.5} />
          </span>
          <span>
            Approved by {review.approval.by}
            {review.approval.credential ? `, ${review.approval.credential}` : ""} · {at}
          </span>
        </p>
        {review.approval.note && <p className="cr-approved-note">“{review.approval.note}”</p>}
      </section>
    );
  }
  // Nothing to approve: a passed review needs no one's name, and an out-of-date one must be checked again first.
  if (!current || review.status === "passed") return null;
  const canApprove = context.principal.kind === "human" && APPROVERS.includes(context.workspace.role);
  if (!canApprove)
    return (
      <section className="cr-approve" aria-label="Approval">
        <p className="cr-why">{context.principal.kind !== "human" ? "An agent can’t approve a review. A person has to." : "Only a workspace owner, admin or reviewer can approve."}</p>
      </section>
    );
  const blocked = dirty || offline;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || blocked) return;
    const next = { by: by.replace(/\s+/g, " ").trim(), credential: credential.replace(/\s+/g, " ").trim(), note: note.trim() };
    const found = {
      by: next.by.length >= 2 ? undefined : "Write the approver’s full name.",
      credential: !regulated || next.credential ? undefined : `Add the approver’s qualification, like “${CREDENTIAL_EXAMPLE[review.domain]}”.`,
      note: !blocking || next.note.length >= 20 ? undefined : "Say why the items to fix are acceptable, in at least 20 characters.",
    };
    setProblems(found);
    const first = found.by ? "cr-by" : found.credential ? "cr-credential" : found.note ? "cr-note" : null;
    if (first) return document.getElementById(first)?.focus();
    const payload = JSON.stringify({ reviewId: review.id, ...next });
    if (attempt.current?.payload !== payload) attempt.current = { payload, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const approved = await state.approve({ reviewId: review.id, ...next, operationKey: attempt.current.key });
      approvedHere.current = true;
      state.setReview(approved);
      state.setAnnouncement(`Approved by ${approved.approval?.by ?? next.by}.`);
    } catch (failure) {
      setError(messageOf(failure, "The approval wasn’t saved. Check your connection and try again."));
      setBusy(false);
    }
  }
  const field = (key: "by" | "credential" | "note") => ({
    "aria-invalid": problems[key] ? true : undefined,
    "aria-describedby": problems[key] ? `cr-${key}-error` : undefined,
  });
  return (
    <section className="cr-approve" aria-labelledby="cr-approve-title">
      <h4 id="cr-approve-title">Approval</h4>
      <p className="cr-approve-lead">
        {regulated
          ? `A ${DOMAIN_LABEL[review.domain].toLocaleLowerCase()} script needs a qualified person’s name and credential before it can be scheduled.`
          : "Your name goes on this version of the script."}
        {blocking > 0 && ` ${blocking === 1 ? "One item is" : `${blocking} items are`} still to fix, so say why ${blocking === 1 ? "it is" : "they are"} acceptable.`}
      </p>
      <form className="cr-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="field">
          <label htmlFor="cr-by">Approver’s name</label>
          <input id="cr-by" value={by} maxLength={120} autoComplete="name" placeholder="Dr. Eleni Papadopoulou" disabled={busy} {...field("by")} onChange={(event) => { setBy(event.target.value); setProblems((current) => ({ ...current, by: undefined })); }} />
          {problems.by && <small className="cr-error" id="cr-by-error">{problems.by}</small>}
        </div>
        <div className="field">
          <label htmlFor="cr-credential">
            Credential {!regulated && <span>Optional</span>}
          </label>
          <input id="cr-credential" value={credential} maxLength={160} autoComplete="organization-title" placeholder={CREDENTIAL_EXAMPLE[review.domain] || "Head of compliance"} disabled={busy} {...field("credential")} onChange={(event) => { setCredential(event.target.value); setProblems((current) => ({ ...current, credential: undefined })); }} />
          {problems.credential && <small className="cr-error" id="cr-credential-error">{problems.credential}</small>}
        </div>
        <div className="field">
          <label htmlFor="cr-note">
            {blocking > 0 ? "Why the items to fix are acceptable" : "Note"} {!blocking && <span>Optional</span>}
          </label>
          <textarea id="cr-note" rows={blocking > 0 ? 3 : 2} value={note} maxLength={800} disabled={busy} placeholder={blocking > 0 ? "The disclaimer is added in the edit before rendering." : ""} {...field("note")} onChange={(event) => { setNote(event.target.value); setProblems((current) => ({ ...current, note: undefined })); }} />
          {problems.note && <small className="cr-error" id="cr-note-error">{problems.note}</small>}
        </div>
        {error && <Notice error>{error}</Notice>}
        <button type="submit" className="button primary cr-approve-button" disabled={blocked} aria-disabled={busy || undefined} aria-describedby={blocked ? whyId : undefined}>
          {busy ? "Approving…" : `Approve version ${review.itemRevision}`}
        </button>
      </form>
    </section>
  );
}
