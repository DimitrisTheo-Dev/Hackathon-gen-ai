import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { instantSchema } from "../../contracts/src/index.js";
import { requireHuman, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError, StoreConflict } from "./errors.js";
import { isSocialPlatform, subscribeProviderAccounts, type SocialPlatform } from "./socials.js";
import { respondToActivity, sendDueCampaignMessages } from "./socials-campaigns.js";
import { nativeWebhooks } from "./socials-webhooks.js";
import type { Row } from "./store.js";
import { parse } from "./studio.js";

/**
 * What happens on connected accounts: comments, likes, messages, new posts and stories. Every platform has one
 * delivery address, /v1/socials/:platform/webhook, and every delivery ends up as rows in `social_events` in one
 * shared shape, whatever sent it.
 *
 * Each address takes two formats:
 *   the platform's own   what Instagram, WhatsApp, TikTok, YouTube or LinkedIn sends, checked with that
 *                        platform's signature (socials-webhooks.ts). Switched on per platform by its credentials.
 *   the generic one      `{ events: [...] }` signed with SOCIALS_WEBHOOK_SECRET and marked by the
 *                        X-Faceful-Signature header: what Faceful's own provider, or any automation, sends.
 *
 * Two things are meant to grow: SOCIAL_EVENT_TYPES (add a name, and it is accepted, stored and listed) and
 * `webhookAdapters` (a platform's own format).
 */
export const SOCIAL_EVENT_TYPES = [
  "post.created",
  "post.failed",
  "post.deleted",
  "story.created",
  "comment.created",
  "comment.deleted",
  "like.created",
  "like.removed",
  "share.created",
  "mention.created",
  "follower.created",
  "message.received",
  "message.sent",
  "message.delivered",
  "message.read",
  "message.failed",
  "message.deleted",
  "account.disconnected",
] as const;
export type SocialEventType = (typeof SOCIAL_EVENT_TYPES)[number];

const text = (max: number) => z.string().max(max).nullable().default(null);
export const socialEventInputSchema = z
  .object({
    /** The sender's own ID for this event. A second delivery with the same ID and type is ignored. */
    id: z.string().min(1).max(200),
    type: z.enum(SOCIAL_EVENT_TYPES),
    /** Which account it happened on: its Faceful ID, or its ID on the platform. */
    accountId: z.uuid().optional(),
    externalAccountId: z.string().min(1).max(200).optional(),
    occurredAt: instantSchema.optional(),
    /** Who did it: the commenter, the person who liked, the sender of a message. */
    actor: z.object({ id: text(500), name: text(200), url: text(2000) }).strict().optional(),
    /** What it is about: the post, story, comment or message. `parentId` is the post a comment or like belongs to. */
    subject: z.object({ id: text(500), url: text(2000), parentId: text(500) }).strict().optional(),
    text: z.string().max(5000).optional(),
    /** Anything else worth keeping, in the sender's own shape. */
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((event) => event.accountId || event.externalAccountId, { message: "Name the account with accountId or externalAccountId" });
export type SocialEventInput = z.input<typeof socialEventInputSchema>;

/** Stores events for every workspace that has the account connected. Unknown accounts are counted, never stored. */
export async function recordSocialEvents(deps: EngineDeps, platform: SocialPlatform, source: string, events: SocialEventInput[]) {
  return (await storeSocialEvents(deps, platform, source, events)).outcome;
}
/** Like `recordSocialEvents`, and also answers with the rows stored now: what happened for the first time. */
async function storeSocialEvents(deps: EngineDeps, platform: SocialPlatform, source: string, events: SocialEventInput[]) {
  const outcome = { received: events.length, stored: 0, duplicates: 0, unmatched: 0 };
  const rows: Row[] = [];
  const received = deps.now().getTime();
  const now = new Date(received).toISOString();
  for (const [index, event] of events.entries()) {
    const accounts = await deps.store.select("provider_connections", event.accountId ? { id: event.accountId, platform } : { platform, external_account_id: event.externalAccountId! });
    if (!accounts.length) {
      outcome.unmatched++;
      continue;
    }
    // One row per workspace, even when the workspace reaches the account through two providers.
    const workspaces = new Map(accounts.map((account) => [account.org_id as string, account]));
    for (const account of workspaces.values()) {
      try {
        const row = await deps.store.insert("social_events", {
          id: crypto.randomUUID(),
          org_id: account.org_id,
          account_id: account.id,
          platform,
          type: event.type,
          source,
          external_id: event.id,
          occurred_at: event.occurredAt ?? now,
          actor: event.actor ?? null,
          subject: event.subject ?? null,
          text: event.text ?? null,
          data: event.data ?? {},
          // One millisecond apart within a delivery, so reading back in pages (`before`) never skips a tie.
          received_at: new Date(received + index).toISOString(),
        });
        rows.push(row);
        outcome.stored++;
      } catch (error) {
        if (!(error instanceof StoreConflict)) throw error;
        outcome.duplicates++;
        continue;
      }
      // Access was withdrawn on the platform. Acted on once: a repeat of an old delivery must not expire an
      // account that has been connected again since.
      if (event.type === "account.disconnected")
        for (const row of accounts.filter((row) => row.org_id === account.org_id)) await deps.store.update("provider_connections", { id: row.id }, { state: "expired", updated_at: now });
    }
  }
  return { outcome, rows };
}

/**
 * What follows a delivery: comment-to-DM campaigns answer what happened for the first time (a repeated delivery is
 * never answered twice), and follow-ups that came due are sent. Never thrown: the delivery itself was accepted.
 */
async function afterDelivery(deps: EngineDeps, rows: Row[]) {
  await respondToActivity(deps, rows);
  await sendDueCampaignMessages(deps).catch(() => undefined);
}

/* ───────────────────────── deliveries ───────────────────────── */

export interface WebhookAdapter {
  /** Recorded on each event, so it is clear where it came from. */
  source: string;
  /** Answers the check a platform makes (a GET) when the address is registered: what to send back, or null to refuse. */
  handshake?(deps: EngineDeps, query: URLSearchParams): WebhookAnswer | null | Promise<WebhookAnswer | null>;
  /** True only when the delivery provably came from the sender. Works on the exact bytes received (and the address's query). */
  verify(deps: EngineDeps, headers: Headers, rawBody: string, query?: URLSearchParams): boolean;
  /** One delivery → the events in it, in the shared shape. */
  parse(rawBody: string): { source?: string; events: SocialEventInput[] };
  /**
   * For platforms where the engine itself can ask for an account's activity to be sent here. Called when an
   * account is connected and again every few days. False: not possible on this deployment, nothing was asked.
   */
  subscribe?(deps: EngineDeps, account: Row): Promise<boolean>;
}
export interface WebhookAnswer {
  body: string;
  contentType: string;
}

const SIGNATURE_HEADER = "x-faceful-signature";
const TOLERANCE_SECONDS = 300;
const sign = (secret: string, timestamp: number, rawBody: string) => createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
/** The header a sender puts on a delivery: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export function signSocialWebhook(secret: string, rawBody: string, at: Date) {
  const timestamp = Math.floor(at.getTime() / 1000);
  return `t=${timestamp},v1=${sign(secret, timestamp, rawBody).toString("hex")}`;
}
const deliverySchema = z.object({ source: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/).optional(), events: z.array(socialEventInputSchema).min(1).max(100) }).strict();

/** The generic format: `{ "source"?: "...", "events": [ ... ] }`, signed with SOCIALS_WEBHOOK_SECRET. */
const signedWebhook: WebhookAdapter = {
  source: "webhook",
  verify(deps, headers, rawBody) {
    const secret = deps.config.socials.webhookSecret;
    if (!secret) throw new EngineError("provider_unavailable", "Webhook deliveries are not switched on for this deployment yet.");
    const parts = Object.fromEntries((headers.get(SIGNATURE_HEADER) ?? "").split(",").map((part) => part.trim().split("=", 2)));
    const timestamp = Number(parts.t);
    // A captured delivery cannot be replayed later: the signed timestamp has to be recent.
    if (!Number.isInteger(timestamp) || Math.abs(deps.now().getTime() / 1000 - timestamp) > TOLERANCE_SECONDS) return false;
    const expected = sign(secret, timestamp, rawBody);
    const given = Buffer.from(String(parts.v1 ?? ""), "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  },
  parse(rawBody) {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new EngineError("validation_error", "The delivery is not valid JSON.");
    }
    return parse(deliverySchema, payload);
  },
};
/** Each platform's own format. A platform without an entry takes the generic format only. */
export const webhookAdapters: Partial<Record<SocialPlatform, WebhookAdapter>> = { ...nativeWebhooks };

const MAX_DELIVERY_BYTES = 256 * 1024;
function requirePlatform(platformId: string): SocialPlatform {
  if (!isSocialPlatform(platformId)) throw new EngineError("not_found", "This platform is not supported.");
  return platformId;
}

/** GET /v1/socials/:platform/webhook. Null when the platform makes no such check, or this request is not a valid one. */
export async function socialWebhookHandshake(deps: EngineDeps, platformId: string, query: URLSearchParams): Promise<WebhookAnswer | null> {
  return (await webhookAdapters[requirePlatform(platformId)]?.handshake?.(deps, query)) ?? null;
}

/** POST /v1/socials/:platform/webhook. No member session: the signature is the credential. */
export async function receiveSocialWebhook(deps: EngineDeps, platformId: string, headers: Headers, rawBody: string, query?: URLSearchParams) {
  const platform = requirePlatform(platformId);
  // The generic format announces itself with its signature header; anything else is the platform's own.
  const native = headers.has(SIGNATURE_HEADER) ? undefined : webhookAdapters[platform];
  const adapter = native ?? signedWebhook;
  if (rawBody.length > MAX_DELIVERY_BYTES) throw new EngineError("validation_error", "The delivery is too large.");
  if (!adapter.verify(deps, headers, rawBody, query)) throw new EngineError("unauthenticated", "This delivery's signature is missing, too old or wrong.");
  const delivery = adapter.parse(rawBody);
  // A platform retries anything not answered with success, so one entry of its delivery that does not fit the
  // shared shape is left out instead of failing the rest. The generic format was already checked strictly.
  const events = native ? delivery.events.flatMap((event) => socialEventInputSchema.safeParse(event).data ?? []) : delivery.events;
  const { outcome, rows } = await storeSocialEvents(deps, platform, delivery.source ?? adapter.source, events);
  await afterDelivery(deps, rows);
  return outcome;
}

/**
 * Sends events made up by "Try it" (socials-campaigns.ts) the way a sender would: as a delivery in the generic format,
 * signed with SOCIALS_WEBHOOK_SECRET, through the same checks and steps as any other. Without that secret there is no
 * signed address to go through, and they are taken in directly.
 */
export async function deliverTestEvents(deps: EngineDeps, platform: SocialPlatform, events: SocialEventInput[]) {
  const secret = deps.config.socials.webhookSecret;
  if (!secret) {
    const { outcome, rows } = await storeSocialEvents(deps, platform, "test", events);
    await afterDelivery(deps, rows);
    return { via: "direct" as const, outcome };
  }
  const rawBody = JSON.stringify({ source: "test", events });
  const headers = new Headers({ "content-type": "application/json", [SIGNATURE_HEADER]: signSocialWebhook(secret, rawBody, deps.now()) });
  return { via: "webhook" as const, outcome: await receiveSocialWebhook(deps, platform, headers, rawBody) };
}

const RENEW_AFTER_HOURS = 48;

/**
 * Keeps platform subscriptions alive where the engine holds them itself (YouTube's hub forgets one after some
 * days), and asks again for the ones a provider holds that have not taken yet. Runs on the scheduler tick for every
 * workspace, and right after a workspace connects accounts.
 */
export async function renewWebhookSubscriptions(deps: EngineDeps, orgId?: string) {
  const outcome = { renewed: 0, failed: 0 };
  const stale = deps.now().getTime() - RENEW_AFTER_HOURS * 3600_000;
  for (const [platform, adapter] of Object.entries(webhookAdapters)) {
    if (!adapter.subscribe) continue;
    const accounts = await deps.store.select("provider_connections", { platform, state: "connected", ...(orgId ? { org_id: orgId } : {}) });
    for (const account of accounts) {
      if (account.webhook_renewed_at && new Date(account.webhook_renewed_at).getTime() > stale) continue;
      try {
        if (!(await adapter.subscribe(deps, account))) continue;
        await deps.store.update("provider_connections", { id: account.id }, { webhook_renewed_at: deps.now().toISOString() });
        outcome.renewed++;
      } catch {
        // Asked again on the next tick.
        outcome.failed++;
      }
    }
  }
  // Subscriptions a provider holds for its accounts (Instagram directly): asked again until they take.
  const held = await subscribeProviderAccounts(deps, orgId);
  return { renewed: outcome.renewed + held.subscribed, failed: outcome.failed + held.failed };
}

/* ───────────────────────── reading ───────────────────────── */

const listQuerySchema = z
  .object({
    platform: z.string().refine(isSocialPlatform, "Unknown platform").optional(),
    type: z.enum(SOCIAL_EVENT_TYPES).optional(),
    accountId: z.uuid().optional(),
    /** Pass the previous page's `nextBefore` to read older events. */
    before: instantSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const iso = (value: unknown) => new Date(value as string).toISOString();

/**
 * GET /v1/socials/events. Newest first. For signed-in members only: events include private messages, and an
 * agent's permissions do not yet say whether it may read them.
 */
export async function listSocialEvents(deps: EngineDeps, ctx: Ctx, rawQuery: unknown) {
  requireHuman(ctx, "Reading account activity");
  requireScope(ctx, "campaign:read");
  const query = parse(listQuerySchema, rawQuery);
  const rows = await deps.store.select(
    "social_events",
    {
      org_id: ctx.org.id,
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.accountId ? { account_id: query.accountId } : {}),
      ...(query.before ? { received_at: { lt: query.before } } : {}),
    },
    { order: ["received_at", "desc"], limit: query.limit },
  );
  return {
    events: rows.map((row: Row) => ({
      id: row.id as string,
      type: row.type as SocialEventType,
      platform: row.platform as SocialPlatform,
      accountId: (row.account_id as string | null) ?? null,
      source: row.source as string,
      externalId: row.external_id as string,
      occurredAt: iso(row.occurred_at),
      receivedAt: iso(row.received_at),
      actor: row.actor ?? null,
      subject: row.subject ?? null,
      text: (row.text as string | null) ?? null,
      data: row.data ?? {},
    })),
    nextBefore: rows.length === query.limit ? iso(rows[rows.length - 1].received_at) : null,
  };
}
