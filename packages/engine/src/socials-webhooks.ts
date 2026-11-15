import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { EngineError } from "./errors.js";
import type { SocialEventInput, WebhookAdapter } from "./socials-events.js";

/**
 * Each platform's own webhook format: how it proves a delivery is genuine, how it checks the address when the
 * webhook is registered, and what its payload means in the shared event shape (socials-events.ts).
 *
 * Written from the platforms' documentation, read 15 November 2026:
 *   Instagram  developers.facebook.com/documentation/instagram-platform/webhooks (setup, examples)
 *   WhatsApp   developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages
 *   TikTok     developers.tiktok.com/doc/webhooks-verification, /doc/webhooks-events
 *   YouTube    developers.google.com/youtube/v3/guides/push_notifications (PubSubHubbub 0.4)
 *   LinkedIn   learn.microsoft.com/linkedin/shared/api-guide/webhook-validation, organization social action notifications
 *
 * A genuine delivery is never answered with an error for what it contains: anything unrecognised is skipped, so
 * the platform does not retry it for days. What the platforms do not send is not invented here: none of them
 * reports a like on a post or a new story, and TikTok and YouTube report no comments.
 */
type Draft = SocialEventInput;

const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const clip = (value: unknown, max: number) => (typeof value === "number" ? String(value) : typeof value === "string" && value ? value.slice(0, max) : undefined);
const ref = (value: unknown) => clip(value, 500) ?? null;
/** An event's own ID, kept within the stored limit: long or composite IDs are replaced by their digest. */
function key(...parts: unknown[]) {
  const joined = parts.map(String).join(":");
  return joined.length <= 200 ? joined : `sha256:${createHash("sha256").update(joined).digest("hex")}`;
}
const json = (raw: string): any => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
/** Epoch seconds, epoch milliseconds or a date string → ISO. Unreadable → undefined, and the event is stamped on arrival. */
function instant(value: unknown) {
  const epoch = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) : null;
  const ms = epoch === null ? Date.parse(String(value ?? "")) : epoch < 1e12 ? epoch * 1000 : epoch;
  return ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : undefined;
}
function hmacMatches(algorithm: "sha256" | "sha1", secret: string, message: string, givenHex: unknown) {
  const expected = createHmac(algorithm, secret).update(message).digest();
  const given = Buffer.from(typeof givenHex === "string" ? givenHex : "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
function sameText(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function off(label: string): never {
  throw new EngineError("provider_unavailable", `${label} webhooks are not switched on for this deployment yet.`);
}
const plain = (body: string) => ({ body, contentType: "text/plain; charset=utf-8" });
/** A challenge is echoed back, so it is only ever a short token. */
const CHALLENGE = /^[\w.-]{1,200}$/;

/* ───────────────────────── Meta: Instagram and WhatsApp ───────────────────────── */

/**
 * Both are Meta apps. Registering the address sends `hub.mode=subscribe`, the verify token typed into the app's
 * webhook settings and a challenge to send back. Deliveries carry `X-Hub-Signature-256: sha256=<HMAC-SHA256 of
 * the body with the app secret>`.
 */
function metaWebhook(platform: "instagram" | "whatsapp", label: string, events: (payload: any) => Draft[]): WebhookAdapter {
  return {
    source: platform,
    handshake(deps, query) {
      const config = deps.config.socials.native[platform];
      const challenge = query.get("hub.challenge") ?? "";
      if (!config || query.get("hub.mode") !== "subscribe" || !CHALLENGE.test(challenge) || !sameText(query.get("hub.verify_token") ?? "", config.verifyToken)) return null;
      return plain(challenge);
    },
    verify(deps, headers, rawBody) {
      const config = deps.config.socials.native[platform] ?? off(label);
      const header = headers.get("x-hub-signature-256") ?? "";
      return header.startsWith("sha256=") && hmacMatches("sha256", config.appSecret, rawBody, header.slice(7));
    },
    parse: (rawBody) => ({ events: events(json(rawBody)) }),
  };
}

/** Comments (also on live video), mentions, and direct messages with their reactions and read receipts. */
function instagramEvents(payload: any): Draft[] {
  const events: Draft[] = [];
  if (payload?.object !== "instagram") return events;
  for (const entry of list(payload.entry)) {
    // The Instagram professional account the activity belongs to.
    const account = clip(entry?.id, 200);
    if (!account) continue;
    const sentAt = instant(entry.time);
    // One login type puts a single field on the entry itself; the others send a `changes` list.
    const changes = Array.isArray(entry.changes) ? entry.changes : entry.field ? [{ field: entry.field, value: entry.value }] : [];
    for (const change of changes) {
      const value = change?.value ?? {};
      if (change?.field === "comments" || change?.field === "live_comments") {
        const comment = clip(value.id ?? value.comment_id, 500);
        if (!comment) continue;
        events.push({
          id: key(comment),
          type: "comment.created",
          externalAccountId: account,
          occurredAt: sentAt,
          actor: { id: ref(value.from?.id), name: ref(value.from?.username) },
          subject: { id: comment, parentId: ref(value.media?.id) },
          text: clip(value.text, 5000),
          data: { live: change.field === "live_comments", replyTo: value.parent_id, mediaType: value.media?.media_product_type },
        });
      } else if (change?.field === "mentions" && value.media_id) {
        // In a comment when `comment_id` is present, otherwise in the caption of the media itself.
        events.push({
          id: key("mention", value.comment_id ?? value.media_id),
          type: "mention.created",
          externalAccountId: account,
          occurredAt: sentAt,
          subject: { id: ref(value.comment_id ?? value.media_id), parentId: value.comment_id ? ref(value.media_id) : null },
        });
      }
    }
    for (const item of list(entry.messaging)) {
      const sender = ref(item?.sender?.id);
      const base = { externalAccountId: account, occurredAt: instant(item?.timestamp) ?? sentAt, actor: { id: sender } };
      const message = item?.message;
      if (message?.mid) {
        // `is_echo` marks a message the account itself sent.
        events.push({
          ...base,
          id: key(message.mid),
          type: message.is_deleted ? "message.deleted" : message.is_echo ? "message.sent" : "message.received",
          subject: { id: ref(message.mid) },
          text: clip(message.text, 5000),
          data: { attachments: message.attachments, replyTo: message.reply_to?.mid, story: message.reply_to?.story?.id },
        });
      } else if (item?.reaction?.mid) {
        // A reaction can be added, removed and added again, so the time is part of what makes each one distinct.
        events.push({
          ...base,
          id: key("reaction", item.reaction.mid, sender, item.timestamp),
          type: item.reaction.action === "unreact" ? "like.removed" : "like.created",
          subject: { id: ref(item.reaction.mid) },
          data: { on: "message", emoji: item.reaction.emoji },
        });
      } else if (item?.read?.mid) {
        events.push({ ...base, id: key("read", item.read.mid), type: "message.read", subject: { id: ref(item.read.mid) } });
      }
    }
  }
  return events;
}

/** Messages people send to the business number, their reactions, and what became of the messages the number sent. */
function whatsappEvents(payload: any): Draft[] {
  const events: Draft[] = [];
  if (payload?.object !== "whatsapp_business_account") return events;
  const statuses = { sent: "message.sent", delivered: "message.delivered", read: "message.read", failed: "message.failed" } as const;
  for (const entry of list(payload.entry))
    for (const change of list(entry?.changes)) {
      const value = change?.value;
      // The account is the business phone number. `entry.id` is the business account, which can hold several numbers.
      const account = clip(value?.metadata?.phone_number_id, 200);
      if (change?.field !== "messages" || !account) continue;
      const names = new Map<string, unknown>();
      for (const contact of list(value.contacts)) for (const id of [contact?.wa_id, contact?.user_id]) if (id) names.set(String(id), contact.profile?.name);
      for (const message of list(value.messages)) {
        const from = message?.from ?? message?.from_user_id;
        if (!message?.id || message.type === "system") continue;
        const base = { externalAccountId: account, occurredAt: instant(message.timestamp), actor: { id: ref(from), name: ref(names.get(String(from))) } };
        if (message.type === "reaction")
          // No emoji means the person took their reaction back.
          events.push({ ...base, id: key("reaction", message.id), type: message.reaction?.emoji ? "like.created" : "like.removed", subject: { id: ref(message.reaction?.message_id) }, data: { on: "message", emoji: message.reaction?.emoji } });
        else
          events.push({ ...base, id: key(message.id), type: "message.received", subject: { id: ref(message.id) }, text: clip(message.text?.body ?? message[message.type]?.caption, 5000), data: { type: message.type } });
      }
      for (const status of list(value.statuses)) {
        const type = statuses[status?.status as keyof typeof statuses];
        if (!type || !status.id) continue;
        events.push({
          id: key(status.id),
          type,
          externalAccountId: account,
          occurredAt: instant(status.timestamp),
          actor: { id: ref(status.recipient_id ?? status.recipient_user_id) },
          subject: { id: ref(status.id) },
          data: status.errors ? { errors: status.errors } : {},
        });
      }
    }
  return events;
}

/* ───────────────────────── TikTok ───────────────────────── */

/**
 * `TikTok-Signature: t=<timestamp>,s=<HMAC-SHA256 of "<t>.<body>" with the client secret>`. There is no handshake.
 * The timestamp is signed but its age is not enforced: TikTok retries for up to 72 hours, and a repeated event is
 * ignored on arrival anyway.
 */
const tiktokWebhook: WebhookAdapter = {
  source: "tiktok",
  verify(deps, headers, rawBody) {
    const config = deps.config.socials.native.tiktok ?? off("TikTok");
    const parts = Object.fromEntries((headers.get("tiktok-signature") ?? "").split(",").map((part) => part.trim().split("=", 2)));
    return /^\d{1,12}$/.test(parts.t ?? "") && hmacMatches("sha256", config.clientSecret, `${parts.t}.${rawBody}`, parts.s);
  },
  parse(rawBody) {
    const body = json(rawBody);
    const account = clip(body?.user_openid, 200);
    if (!account) return { events: [] };
    // `content` is JSON serialised into a string.
    const content = (typeof body.content === "string" ? json(body.content) : body.content) ?? {};
    const base = { externalAccountId: account, occurredAt: instant(body.create_time) };
    const share = ref(content.share_id);
    if (body.event === "authorization.removed") return { events: [{ ...base, id: key("authorization.removed", body.create_time), type: "account.disconnected", data: { reason: content.reason } }] };
    if (body.event === "video.publish.completed") return { events: [{ ...base, id: key(share ?? body.create_time), type: "post.created", subject: { id: share } }] };
    if (body.event === "video.upload.failed") return { events: [{ ...base, id: key(share ?? body.create_time), type: "post.failed", subject: { id: share } }] };
    return { events: [] };
  },
};

/* ───────────────────────── YouTube ───────────────────────── */

const YOUTUBE_HUB = "https://pubsubhubbub.appspot.com/subscribe";
const YOUTUBE_CHANNEL = /^[A-Za-z0-9_-]{1,64}$/;
const YOUTUBE_TOPIC = /^https:\/\/www\.youtube\.com\/xml\/feeds\/videos\.xml\?channel_id=([A-Za-z0-9_-]{1,64})$/;
const youtubeTopic = (channel: string) => `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channel}`;
const xmlText = (value: string | undefined) => value?.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" })[name as string] ?? "");
const xmlTag = (block: string, name: string) => xmlText(block.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]);
/**
 * The address registered for each channel carries `channel` and `token`, the hex HMAC-SHA256 of the channel ID with
 * the hub secret. Anyone can ask the hub to subscribe the bare address, and a request for an address the hub already
 * knows replaces that subscription's secret, so its deliveries would stop verifying. Without the token nobody else
 * can name this engine's address for a channel, and the handshake and deliveries both refuse what lacks it.
 */
const youtubeToken = (secret: string, channel: string) => createHmac("sha256", secret).update(`youtube-callback.${channel}`).digest("hex");
export const youtubeCallback = (appBaseUrl: string, secret: string, channel: string) => `${appBaseUrl}/v1/socials/youtube/webhook?${new URLSearchParams({ channel, token: youtubeToken(secret, channel) })}`;
/** The channel a callback address was registered for, when its token is genuine; null otherwise. */
function youtubeCallbackChannel(secret: string, query: URLSearchParams | undefined): string | null {
  const channel = query?.get("channel") ?? "";
  return YOUTUBE_CHANNEL.test(channel) && hmacMatches("sha256", secret, `youtube-callback.${channel}`, query?.get("token")) ? channel : null;
}

/**
 * YouTube pushes through Google's PubSubHubbub hub: an Atom feed when a channel uploads a video or edits its title
 * or description. Nothing is configured in a console. The engine asks the hub for each connected channel
 * (`subscribe`) with a secret and its own callback address (youtubeCallback), and the hub signs each delivery with
 * the secret: `X-Hub-Signature: sha1=<HMAC-SHA1 of the body>`.
 */
const youtubeWebhook: WebhookAdapter = {
  source: "youtube",
  async handshake(deps, query) {
    const config = deps.config.socials.native.youtube;
    const challenge = query.get("hub.challenge") ?? "";
    const channel = query.get("hub.topic")?.match(YOUTUBE_TOPIC)?.[1];
    const mode = query.get("hub.mode");
    // Only the address this engine registered for that very channel is confirmed (the hub keeps its query string).
    if (!config || !channel || channel !== youtubeCallbackChannel(config.hubSecret, query) || !CHALLENGE.test(challenge) || (mode !== "subscribe" && mode !== "unsubscribe")) return null;
    // Anyone can ask the hub to subscribe or unsubscribe this address. Only what matches the connected accounts
    // is confirmed: subscribing a channel that is connected, unsubscribing one that no longer is.
    const [connected] = await deps.store.select("provider_connections", { platform: "youtube", external_account_id: channel }, { limit: 1 });
    return Boolean(connected) === (mode === "subscribe") ? plain(challenge) : null;
  },
  verify(deps, headers, rawBody, query) {
    const config = deps.config.socials.native.youtube ?? off("YouTube");
    const header = headers.get("x-hub-signature") ?? "";
    // Sent to an address this engine registered, and signed with the secret it registered there.
    return youtubeCallbackChannel(config.hubSecret, query) !== null && header.startsWith("sha1=") && hmacMatches("sha1", config.hubSecret, rawBody, header.slice(5));
  },
  parse(rawBody) {
    const events: Draft[] = [];
    for (const [, entry] of rawBody.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const video = xmlTag(entry, "yt:videoId");
      const channel = xmlTag(entry, "yt:channelId");
      if (!video || !channel) continue;
      // An edited title or description arrives as the same video again, and is ignored as a repeat.
      events.push({ id: key(video), type: "post.created", externalAccountId: channel.slice(0, 200), occurredAt: instant(xmlTag(entry, "published")), subject: { id: ref(video), url: `https://www.youtube.com/watch?v=${encodeURIComponent(video)}` }, text: clip(xmlTag(entry, "title"), 5000) });
    }
    return { events };
  },
  async subscribe(deps, account) {
    const config = deps.config.socials.native.youtube;
    const channel = String(account.external_account_id ?? "");
    if (!config || !deps.config.appBaseUrl || !YOUTUBE_CHANNEL.test(channel)) return false;
    const response = await deps.fetch(YOUTUBE_HUB, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // The hub confirms with a GET to the callback (the handshake above) before it starts delivering.
      body: new URLSearchParams({ "hub.callback": youtubeCallback(deps.config.appBaseUrl, config.hubSecret, channel), "hub.mode": "subscribe", "hub.topic": youtubeTopic(channel), "hub.verify": "async", "hub.secret": config.hubSecret, "hub.lease_seconds": "864000" }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`hub answered ${response.status}`);
    return true;
  },
};

/* ───────────────────────── LinkedIn ───────────────────────── */

const linkedinActions = { LIKE: "like.created", COMMENT: "comment.created", ADMIN_COMMENT: "comment.created", COMMENT_DELETE: "comment.deleted", SHARE: "share.created", SHARE_MENTION: "mention.created" } as const;

/**
 * Activity on a company page (likes, comments, shares, mentions), sent to apps with LinkedIn's organization social
 * action notifications. Registering the address sends `challengeCode`; the answer is its HMAC-SHA256 with the client
 * secret. Deliveries carry `X-LI-Signature`: the hex HMAC-SHA256 of `"hmacsha256=" + body`.
 */
const linkedinWebhook: WebhookAdapter = {
  source: "linkedin",
  handshake(deps, query) {
    const config = deps.config.socials.native.linkedin;
    const code = query.get("challengeCode") ?? "";
    // Only codes shaped like LinkedIn's (hex and dashes) are answered. Answering any text would sign it with the
    // client secret for whoever asks, including the "hmacsha256=…" string that makes a forged delivery pass.
    if (!config || !/^[0-9a-f-]{8,64}$/i.test(code)) return null;
    return { body: JSON.stringify({ challengeCode: code, challengeResponse: createHmac("sha256", config.clientSecret).update(code).digest("hex") }), contentType: "application/json; charset=utf-8" };
  },
  verify(deps, headers, rawBody) {
    const config = deps.config.socials.native.linkedin ?? off("LinkedIn");
    return hmacMatches("sha256", config.clientSecret, `hmacsha256=${rawBody}`, headers.get("x-li-signature"));
  },
  parse(rawBody) {
    const body = json(rawBody);
    const events: Draft[] = [];
    if (body?.type !== "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS") return { events };
    for (const notification of list(body.notifications)) {
      const type = linkedinActions[notification?.action as keyof typeof linkedinActions];
      // The page, as its organization URN.
      const account = clip(notification?.organizationalEntity, 200);
      if (!type || !account || notification.notificationId === undefined) continue;
      const made = notification.decoratedGeneratedActivity?.comment ?? notification.decoratedGeneratedActivity?.share;
      events.push({
        // Every admin who subscribed receives the same notification; the ID keeps it to one event.
        id: key(notification.notificationId, notification.generatedActivity ?? notification.sourcePost ?? ""),
        type,
        externalAccountId: account,
        occurredAt: instant(notification.lastModifiedAt),
        actor: { id: ref(made?.owner) },
        subject: { id: ref(notification.generatedActivity ?? notification.sourcePost), parentId: ref(notification.sourcePost) },
        text: clip(made?.text, 5000),
      });
    }
    return { events };
  },
};

export const nativeWebhooks = {
  instagram: metaWebhook("instagram", "Instagram", instagramEvents),
  whatsapp: metaWebhook("whatsapp", "WhatsApp", whatsappEvents),
  tiktok: tiktokWebhook,
  youtube: youtubeWebhook,
  linkedin: linkedinWebhook,
};
