import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, CircleAlert, LoaderCircle } from "lucide-react";
import type { StudioContext } from "@castroom/contracts";
import type { BillingStatus, StudioClient } from "../data/client";
import { dateLabel } from "../components/ui";

const statusLabels: Record<BillingStatus["status"], string> = {
  not_configured: "Not set up",
  free: "Free",
  checkout_pending: "Checkout started",
  trialing: "Trial",
  active: "Active",
  past_due: "Payment overdue",
  cancelled: "Cancelled",
  incomplete: "Payment incomplete",
  unpaid: "Unpaid",
  paused: "Paused",
};
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/**
 * Plan, credits and the single upgrade path. Everything shown comes from the server's
 * record of verified Stripe events — returning from Checkout never marks anything as paid.
 */
export function Billing({
  client,
  context,
  checkoutReturn,
  onReturnHandled,
}: {
  client: StudioClient;
  context: StudioContext;
  checkoutReturn: "success" | "cancelled" | null;
  onReturnHandled: () => void;
}) {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);
  const [confirming, setConfirming] = useState(checkoutReturn === "success");
  const [confirmNote, setConfirmNote] = useState("");
  const baseline = useRef<{ status: string; credits: number } | null>(null);
  const checkoutKey = useRef(crypto.randomUUID());
  // Kept in a ref so a parent re-render never restarts the confirmation polling below.
  const returnHandled = useRef(onReturnHandled);
  returnHandled.current = onReturnHandled;
  const load = useCallback(async () => {
    try {
      const next = await client.getBilling();
      setBilling(next); setError("");
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Billing could not be loaded.");
      return null;
    }
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  // After Checkout, wait for Stripe's webhook to reach the server. The redirect itself proves nothing.
  useEffect(() => {
    if (!confirming) return;
    let active = true;
    let attempts = 0;
    const timer = window.setInterval(async () => {
      attempts++;
      const next = await load();
      if (!active || !next) return;
      baseline.current ??= { status: next.status, credits: next.creditBalance };
      const confirmed = ["active", "trialing"].includes(next.status);
      const changed = next.status !== baseline.current.status || next.creditBalance !== baseline.current.credits;
      if (confirmed || (changed && next.status !== "checkout_pending")) {
        setConfirming(false); returnHandled.current();
        setConfirmNote(confirmed ? "Stripe confirmed your subscription. Your plan and credits are up to date." : "Your billing status changed. The current state is shown below.");
      } else if (attempts >= 20) {
        setConfirming(false); returnHandled.current();
        setConfirmNote("Stripe has not confirmed this checkout yet. Nothing has been added to your plan. Check again in a minute; if you completed payment, it will appear here once Stripe confirms it.");
      }
    }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [confirming, load]);
  async function upgrade() {
    if (!billing?.plans[0] || busy) return;
    setBusy("checkout"); setError("");
    try {
      const result = await client.createCheckout({ priceKey: billing.plans[0].key, confirmationGranted: true, operationKey: checkoutKey.current });
      location.assign(result.checkoutUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Checkout could not be started. Nothing was charged.");
      setBusy(null);
    }
  }
  async function manage() {
    if (busy) return;
    setBusy("portal"); setError("");
    try {
      location.assign((await client.createPortal()).portalUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The billing portal could not be opened.");
      setBusy(null);
    }
  }
  const subscribed = billing ? ["active", "trialing", "past_due"].includes(billing.status) : false;
  const tone = !billing ? "" : billing.status === "active" || billing.status === "trialing" ? "good" : ["past_due", "unpaid", "incomplete"].includes(billing.status) ? "bad" : "";
  const plan = billing?.plans[0] ?? null;
  const sandbox = billing?.mode === "sandbox";
  return (
    <div className="billing-view ob-billing">
      <header className="ob-page-head">
        <div>
          <h1>Billing and usage</h1>
          <p>Drafting, editing and planning are free. Rendering a video uses credits.</p>
        </div>
        {sandbox && <span className="ob-test-mode">Test mode — no real charges</span>}
      </header>

      {checkoutReturn === "cancelled" && (
        <div className="success-note ob-note" role="status">
          <span>Checkout was cancelled. Nothing was charged and your drafts are unchanged.</span>
          <button className="ob-link" onClick={onReturnHandled}>Dismiss</button>
        </div>
      )}
      {confirming && <p className="ob-note ob-note-pending" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" />Waiting for Stripe to confirm your checkout. Your plan updates here as soon as it does.</p>}
      {confirmNote && <div className="success-note ob-note" role="status"><Check size={15} strokeWidth={2.25} aria-hidden="true" /><span>{confirmNote}</span></div>}
      {error && <p className="ob-error" role="alert">{error} <button className="ob-link" onClick={() => void load()}>Try again</button></p>}

      {!billing && !error && (
        <div className="ob-billing-cards" role="status">
          <span className="sr-only">Loading billing…</span>
          <div className="ob-billing-card ob-skeleton-card"><i /><i /><i /></div>
          <div className="ob-billing-card ob-skeleton-card"><i /><i /><i /></div>
        </div>
      )}

      {billing && (
        <>
          <dl className="ob-billing-cards">
            <div className="ob-billing-card">
              <dt>Render credits</dt>
              <dd>
                <span className="billing-number">{billing.creditBalance}</span>
                <span className="ob-billing-sub">{billing.rendersRemaining} {plural(billing.rendersRemaining, "video", "videos")} left · {billing.renderCreditCost} {plural(billing.renderCreditCost, "credit", "credits")} per video</span>
              </dd>
            </div>
            <div className="ob-billing-card">
              <dt>Plan</dt>
              <dd>
                <span className="ob-plan-name">{billing.planKey ? `${billing.planKey[0].toUpperCase()}${billing.planKey.slice(1)} plan` : "Free"}</span>
                {/* "Free" already says it; a chip appears only when the status adds something. */}
                {(billing.planKey || billing.status !== "free") && <span className="ob-plan-status" data-tone={tone || undefined}>{statusLabels[billing.status]}</span>}
                {billing.currentPeriodEnd && <span className="ob-billing-sub">{billing.cancelAtPeriodEnd ? "Ends" : "Renews"} {dateLabel(billing.currentPeriodEnd, context.workspace.timezone, true)}</span>}
                {!billing.currentPeriodEnd && <span className="ob-billing-sub">{subscribed ? "Managed on Stripe" : "No subscription yet"}</span>}
              </dd>
            </div>
          </dl>

          <ul className="ob-credit-facts">
            <li><Check size={15} strokeWidth={2.25} aria-hidden="true" />One credit renders one video. Drafts, edits and schedules never use credits.</li>
            <li><Check size={15} strokeWidth={2.25} aria-hidden="true" />The studio and your connected agents share this one balance.</li>
            <li><Check size={15} strokeWidth={2.25} aria-hidden="true" />A render that fails or is cancelled gives its credit back.</li>
          </ul>

          {billing.status === "past_due" && <p className="ob-error" role="alert">Your last payment did not go through. Update your payment method on Stripe to keep rendering.</p>}

          {billing.mode === "not_configured" ? (
            <section className="ob-upgrade ob-upgrade-blocked" aria-labelledby="billing-blocked">
              <h2 id="billing-blocked">Upgrades aren’t available yet</h2>
              <p className="ob-blocked"><CircleAlert size={16} aria-hidden="true" /><span><strong>Stripe test billing is not connected to this deployment.</strong> {billing.configurationProblem ?? "Stripe sandbox keys have not been added."}</span></p>
              <p className="ob-fine">Nothing can be charged. Drafting, editing and your existing credits keep working.</p>
            </section>
          ) : (
            <section className="ob-upgrade" aria-labelledby="billing-plan">
              <h2 id="billing-plan">{subscribed ? "Your subscription" : "Upgrade"}</h2>
              {!subscribed && plan && (
                <>
                  <p className="ob-upgrade-lead"><strong className="ob-count">{plan.creditsPerPeriod}</strong> render credits every billing period, for the studio and your agents alike.</p>
                  {billing.canCheckout ? (
                    <button className="ob-button ob-button-primary" disabled={busy !== null || confirming} onClick={() => void upgrade()}>
                      {busy === "checkout" ? <><LoaderCircle size={16} className="spin" aria-hidden="true" />Opening Stripe…</> : <>Upgrade with Stripe test checkout<ArrowUpRight size={15} aria-hidden="true" /></>}
                    </button>
                  ) : <p className="ob-fine">Only a workspace owner or admin can upgrade this workspace.</p>}
                  <p className="ob-fine">You pay on Stripe’s page. Card details never enter Faceful or the chat, and your plan changes only after Stripe confirms the payment.</p>
                </>
              )}
              {subscribed && <p className="ob-upgrade-lead">Your credits are topped up each billing period. Change or cancel the plan on Stripe.</p>}
              {billing.hasCustomer && billing.canManage && (
                <button className="ob-button ob-button-quiet" disabled={busy !== null} onClick={() => void manage()}>
                  {busy === "portal" ? <><LoaderCircle size={16} className="spin" aria-hidden="true" />Opening Stripe…</> : <>Manage billing on Stripe<ArrowUpRight size={15} aria-hidden="true" /></>}
                </button>
              )}
              <p className="ob-fine ob-test-card">Stripe test mode. Pay with Stripe’s test card <span className="ob-count">4242 4242 4242 4242</span>, any future date and any CVC.</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
