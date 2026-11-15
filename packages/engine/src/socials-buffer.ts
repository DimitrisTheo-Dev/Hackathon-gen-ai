import { z } from "zod";
import type { EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";
import type { PostStatus, ProviderAccount, SocialPlatform, SocialProvider } from "./socials.js";

/**
 * Buffer (https://developers.buffer.com): one GraphQL endpoint, a personal API key as the bearer token.
 * A Buffer "channel" is one connected social account. Buffer has no webhooks and no upload endpoint: media
 * is fetched from a public URL when the post goes out, and activity on a post has to be read back.
 *
 * The API key belongs to one Buffer account and reaches every organization in it. A workspace connects its
 * own key; the key is stored encrypted on the workspace's account rows (socials.ts).
 */
const ENDPOINT = "https://api.buffer.com";
const credentialsSchema = z.object({
  apiKey: z.string().trim().min(16).max(400),
  /** Limit the connection to one Buffer organization. Omitted: every organization the key reaches. */
  organizationId: z.string().trim().min(1).max(160).optional(),
}).strict();
type Credentials = z.infer<typeof credentialsSchema>;

/** Buffer's service name is also this studio's platform ID for every platform we use. */
const PLATFORMS: SocialPlatform[] = ["tiktok", "instagram", "linkedin", "youtube"];

/**
 * One request. GraphQL answers 200 even on failure, so the body decides. `write` marks a request that may have
 * created something: if its outcome is unclear it is never retried, because Buffer has no idempotency key and a
 * retry could post twice.
 */
async function request<T>(deps: EngineDeps, apiKey: string, query: string, variables: Record<string, unknown>, write = false): Promise<T> {
  const unclear = () =>
    write
      ? new EngineError("unknown_outcome", "Buffer did not confirm whether it accepted this post. Check Buffer before sending it again.")
      : new EngineError("provider_unavailable", "Buffer could not be reached. Try again in a moment.");
  let response: Response;
  try {
    response = await deps.fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw unclear();
  }
  // A refusal is read from the status first: its body is not always JSON.
  const result: any = await response.json().catch(() => null);
  const code = result?.errors?.[0]?.extensions?.code;
  if (response.status === 429 || code === "RATE_LIMIT_EXCEEDED")
    throw new EngineError("quota_exceeded", "Buffer's request limit for this account has been reached. Try again later.", { retryAfterSeconds: Number(response.headers.get("retry-after")) || null });
  // The live API answers a bad key with HTTP 401 and "UNAUTHENTICATED"; its documentation says "UNAUTHORIZED" in a 200.
  if (response.status === 401 || response.status === 403 || code === "UNAUTHENTICATED" || code === "UNAUTHORIZED" || code === "FORBIDDEN")
    throw new EngineError("forbidden", "Buffer did not accept this API key. Create a new key in Buffer (Settings → API) and connect it again.");
  if (code === "NOT_FOUND") throw new EngineError("not_found", "Buffer could not find that organization, channel or post.");
  if (!response.ok || result?.errors?.length || !result?.data) throw unclear();
  return result.data as T;
}

async function listAccounts(deps: EngineDeps, credentials: Credentials): Promise<ProviderAccount[]> {
  const { account } = await request<{ account: { organizations: Array<{ id: string }> } }>(deps, credentials.apiKey, "query { account { organizations { id } } }", {});
  let organizations = account.organizations.map((organization) => organization.id);
  if (credentials.organizationId) {
    if (!organizations.includes(credentials.organizationId)) throw new EngineError("validation_error", "This API key does not reach that Buffer organization.");
    organizations = [credentials.organizationId];
  }
  const accounts: ProviderAccount[] = [];
  for (const organizationId of organizations.slice(0, 10)) {
    const { channels } = await request<{ channels: Array<Record<string, any>> }>(
      deps,
      credentials.apiKey,
      "query Channels($input: ChannelsInput!) { channels(input: $input) { id name displayName service serviceId externalLink isDisconnected isLocked } }",
      { input: { organizationId } },
    );
    for (const channel of channels)
      accounts.push({
        platform: channel.service,
        externalAccountId: String(channel.serviceId || channel.id),
        providerAccountId: String(channel.id),
        displayName: String(channel.displayName || channel.name || channel.service),
        profileUrl: typeof channel.externalLink === "string" && channel.externalLink.startsWith("https://") ? channel.externalLink : null,
        // A locked channel (plan downgrade) or a disconnected one cannot be posted to until fixed in Buffer.
        state: channel.isDisconnected || channel.isLocked ? "unavailable" : "connected",
      });
  }
  return accounts;
}

/** Network-specific settings Buffer needs. Returns null where it needs none. */
function metadata(platform: string, payload: Record<string, any>) {
  const isAiGenerated = Boolean(payload.aiDisclosure);
  if (platform === "instagram") return { instagram: { type: "reel", shouldShareToFeed: true, isAiGenerated } };
  if (platform === "tiktok") return { tiktok: { isAiGenerated } };
  if (platform === "youtube") {
    if (!payload.title) throw new EngineError("validation_error", "YouTube needs a title. Add one and approve the schedule again.");
    // 22 is "People & Blogs". Buffer requires a category and the studio does not ask for one yet.
    return { youtube: { title: payload.title, categoryId: "22", privacy: payload.visibility, isAiGenerated } };
  }
  return null;
}

async function publish(deps: EngineDeps, input: Parameters<SocialProvider<Credentials>["publish"]>[1]) {
  const { account, payload } = input;
  // Buffer can only set visibility on YouTube. Posting publicly what was approved as private would break the approval.
  if (account.platform !== "youtube" && payload.visibility !== "public")
    throw new EngineError("unsupported", `Buffer can only post publicly to ${account.platform}. Set this post to public and approve the schedule again.`);
  const network = metadata(account.platform, payload);
  const data = await request<{ createPost: { post?: { id: string; status: string; externalLink: string | null }; message?: string } }>(
    deps,
    input.credentials.apiKey,
    "mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id status externalLink } } ... on MutationError { message } } }",
    {
      input: {
        channelId: account.provider_account_id,
        text: payload.caption ?? "",
        // The scheduler holds a post until its approved time and re-checks it then, so Buffer is told to send it now.
        schedulingType: "automatic",
        mode: "shareNow",
        assets: [{ video: { url: input.mediaUrl } }],
        ...(network ? { metadata: network } : {}),
      },
    },
    true,
  );
  const post = data.createPost?.post;
  if (!post?.id) throw new EngineError("validation_error", `Buffer did not accept this post${data.createPost?.message ? `: ${String(data.createPost.message).slice(0, 300)}` : "."}`);
  return { providerPostId: post.id, state: post.status === "sent" ? ("verified_published" as const) : ("submitted" as const), url: post.externalLink ?? null };
}

async function postStatus(deps: EngineDeps, input: { credentials: Credentials; providerPostId: string }): Promise<PostStatus> {
  const { post } = await request<{ post: { status: string; externalLink: string | null; sentAt: string | null; error: { message: string } | null } }>(
    deps,
    input.credentials.apiKey,
    "query Post($input: PostInput!) { post(input: $input) { status externalLink sentAt error { message } } }",
    { input: { id: input.providerPostId } },
  );
  if (post.status === "sent") return { state: "published", url: post.externalLink ?? null, publishedAt: post.sentAt ?? null, error: null };
  if (post.status === "error") return { state: "failed", url: null, publishedAt: null, error: post.error?.message ? `The network refused this post: ${post.error.message.slice(0, 300)}` : "The network refused this post." };
  return { state: "pending", url: null, publishedAt: null, error: null };
}

export const bufferProvider: SocialProvider<Credentials> = { id: "buffer", label: "Buffer", platforms: PLATFORMS, credentialsSchema, listAccounts, publish, postStatus };
