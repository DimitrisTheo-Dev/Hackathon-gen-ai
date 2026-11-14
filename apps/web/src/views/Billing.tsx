import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, LoaderCircle } from "lucide-react";
import type { StudioContext } from "@castroom/contracts";
import type { BillingStatus, StudioClient } from "../data/client";
import { Notice, dateLabel } from "../components/ui";

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
  return (
    <div className="brand-view billing-view">
      <span className="section-kicker">{context.workspace.name}</span>
      <h1>Billing and usage</h1>
      <p className="lead">Drafting, editing and planning are free. Rendering a video uses credits.</p>
      {checkoutReturn === "cancelled" && (
        <div className="success-note" role="status">Checkout was cancelled. Nothing was charged and your drafts are unchanged.
          <button className="text-button" onClick={onReturnHandled}>Dismiss</button>
        </div>
      )}
      {confirming && <p className="billing-confirming" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" />Waiting for Stripe to confirm your checkout. Your plan updates here as soon as it does.</p>}
      {confirmNote && <div className="success-note" role="status">{confirmNote}</div>}
      {error && <Notice error>{error} <button className="text-button" onClick={() => void load()}>Try again</button></Notice>}
      {!billing && !error && <p role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Loading billing…</p>}
      {billing && (
        <>
          <dl className="billing-facts">
            <div><dt>Plan</dt><dd>{billing.planKey ? `${billing.planKey[0].toUpperCase()}${billing.planKey.slice(1)} plan` : "Free"}<span className={`status-chip ${billing.status === "active" || billing.status === "trialing" ? "accepted" : ["past_due", "unpaid", "incomplete"].includes(billing.status) ? "failed" : ""}`}>{statusLabels[billing.status]}</span></dd></div>
            <div><dt>Render credits</dt><dd className="billing-number">{billing.creditBalance}</dd></div>
            <div><dt>Videos you can render</dt><dd className="billing-number">{billing.rendersRemaining}<small>{billing.renderCreditCost} credit{billing.renderCreditCost === 1 ? "" : "s"} per render</small></dd></div>
            {billing.currentPeriodEnd && <div><dt>{billing.cancelAtPeriodEnd ? "Ends" : "Renews"}</dt><dd>{dateLabel(billing.currentPeriodEnd, context.workspace.timezone, true)}</dd></div>}
          </dl>
          {billing.status === "past_due" && <Notice error>Your last payment did not go through. Update your payment method in the billing portal to keep rendering.</Notice>}
          {billing.mode === "not_configured" ? (
            <section aria-labelledby="billing-blocked">
              <h2 id="billing-blocked">Upgrades aren’t available yet</h2>
              <Notice>
                <strong>Stripe test billing is not connected to this deployment.</strong>
                <p>{billing.configurationProblem ?? "Stripe sandbox keys have not been added."}</p>
                <p>Nothing can be charged. Drafting, editing and your existing credits keep working.</p>
              </Notice>
            </section>
          ) : (
            <section aria-labelledby="billing-plan">
              <h2 id="billing-plan">{subscribed ? "Your subscription" : "Upgrade"}</h2>
              {!subscribed && billing.plans[0] && (
                <>
                  <ul className="rule-list">
                    <li><Check size={16} aria-hidden="true" />{billing.plans[0].creditsPerPeriod} render credits each billing period</li>
                    <li><Check size={16} aria-hidden="true" />Payment happens on Stripe’s hosted page, in test mode. No real charge is made.</li>
                    <li><Check size={16} aria-hidden="true" />Your plan changes only after Stripe confirms the payment.</li>
                  </ul>
                  {billing.canCheckout ? (
                    <button className="button primary" disabled={busy !== null || confirming} onClick={() => void upgrade()}>
                      {busy === "checkout" ? "Opening Stripe…" : "Upgrade with Stripe test checkout"}<ArrowUpRight size={14} aria-hidden="true" />
                    </button>
                  ) : <p className="muted">Only a workspace owner or admin can upgrade this workspace.</p>}
                </>
              )}
              {billing.hasCustomer && billing.canManage && (
                <button className="button secondary" disabled={busy !== null} onClick={() => void manage()}>
                  {busy === "portal" ? "Opening Stripe…" : "Manage billing on Stripe"}<ArrowUpRight size={14} aria-hidden="true" />
                </button>
              )}
              <p className="billing-mode">Stripe test mode · use Stripe’s test cards only</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
