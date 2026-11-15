import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { authenticate, type EngineDeps, type Principal } from "./access.js";
import type { RateLimitConfig, RateLimitPolicy } from "./config.js";
import { EngineError } from "./errors.js";
import type { RateLimitHit, Store } from "./store.js";

/**
 * Request rate limiting for `/v1/studio/*`, `/v1/socials/*`, `/v1/worker/*` (failed credentials only) and `/mcp`.
 *
 * Authority: one Postgres function (`engine_rate_limit_hit`, migration 20261115010000) counts every request in
 * fixed windows, so limits hold across all function instances. Buckets:
 *   • principal  — every authenticated request, per user / OAuth agent / workspace token;
 *   • director   — model-backed Director turns, per principal (each costs money);
 *   • costly     — render, checkout, channel connection and social provider connect/sync, per principal
 *                  (spend money or call providers);
 *   • anonymous  — requests with no credential, per client network;
 *   • failed_auth — requests whose credential was refused, per client network.
 * Exempt: the Stripe webhook and social deliveries (signature-verified; a refused social signature counts as a
 * failed credential) and an authorized scheduler tick or render worker.
 *
 * Degradation: if the limiter's database call fails, requests are let through (fail open) with a structured
 * log, so a broken limiter cannot take the product down. The failed-auth bucket is the exception: it falls back
 * to a per-instance counter, because traffic in that bucket is by definition not a working session — enforcing
 * it locally cannot lock a signed-in person out, while dropping it would remove brute-force throttling exactly
 * when the database is under stress. The request itself is still refused (401) either way.
 */

export interface RateLimitEvaluation {
  policy: RateLimitPolicy;
  remaining: number;
  resetSeconds: number;
}

const MESSAGES: Record<RateLimitPolicy["name"], string> = {
  principal: "Too many requests from this account or connection.",
  director: "The Creative Director is receiving requests faster than this workspace allows.",
  costly: "Too many render, checkout or channel requests in a short time.",
  anonymous: "Too many requests without signing in from this network.",
  failed_auth: "Too many requests with a missing, expired or invalid credential from this network.",
};

/** The bucket identity of a verified caller. IDs only; never a token or an email address. */
export function principalSubject(principal: Principal): string {
  if (principal.kind === "agent" && principal.via === "token") return `token:${principal.connectionId}`;
  if (principal.kind === "agent") return `oauth:${principal.userId}`;
  return `user:${principal.userId}`;
}

function expandIpv6(address: string): string[] {
  let value = address.toLowerCase();
  const embedded = value.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (embedded) {
    const [a, b, c, d] = embedded.slice(1).map(Number);
    value = `${value.slice(0, -embedded[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = value.split("::");
  const front = head ? head.split(":") : [];
  const back = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : new Array(Math.max(0, 8 - front.length - back.length)).fill("0");
  return [...front, ...fill, ...back].map((group) => parseInt(group || "0", 16).toString(16));
}

/**
 * Canonical network for bucketing: an IPv4 address, or the /64 prefix of an IPv6 address (one subscriber
 * usually controls a whole /64, so per-address IPv6 buckets would be trivial to rotate). Null when invalid.
 */
export function normalizeNetwork(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith("[")) value = value.slice(1, value.indexOf("]") > 0 ? value.indexOf("]") : undefined);
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];
  return `${expandIpv6(value).slice(0, 4).join(":")}::/64`;
}

/**
 * The client's network, or null when it cannot be known. Only trusted behind Vercel's edge, which overwrites
 * `x-forwarded-for` (and `x-real-ip`) with the connecting client's address — so the left-most entry is the
 * client and cannot be chosen by it. Without that guarantee every caller would share one bucket (letting one
 * client throttle everyone), so per-network limits are skipped instead.
 */
export function clientNetwork(headers: Headers, trustProxyHeaders: boolean): string | null {
  if (!trustProxyHeaders) return null;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || headers.get("x-real-ip")?.trim() || "";
  return candidate ? normalizeNetwork(candidate) : null;
}

/** Network buckets are keyed by a digest: the counter table never holds a raw IP address. */
function networkSubject(network: string) {
  return `net:${createHash("sha256").update(`faceful-rate-limit:${network}`).digest("hex").slice(0, 32)}`;
}

/* ───────────── per-instance state (keyed by store, so separate engines never share it) ───────────── */

interface InstanceState {
  /** Fallback counters for the failed-auth bucket while the database limiter is unavailable. */
  fallback: Map<string, { windowStart: number; hits: number }>;
}
const instances = new WeakMap<Store, InstanceState>();
function stateFor(store: Store): InstanceState {
  let state = instances.get(store);
  if (!state) instances.set(store, (state = { fallback: new Map() }));
  return state;
}
function localHit(state: InstanceState, key: string, policy: RateLimitPolicy): RateLimitHit {
  const now = Date.now();
  const windowMs = policy.windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  if (state.fallback.size > 10_000) state.fallback.clear();
  const current = state.fallback.get(key);
  const entry = current && current.windowStart === windowStart ? current : { windowStart, hits: 0 };
  entry.hits++;
  state.fallback.set(key, entry);
  return { allowed: entry.hits <= policy.limit, remaining: Math.max(0, policy.limit - entry.hits), resetSeconds: Math.ceil((windowStart + windowMs - now) / 1000) };
}

const lastUnavailableLog = new Map<string, number>();
function logUnavailable(policy: RateLimitPolicy, mode: "fail_open" | "local_fallback", error: unknown) {
  // At most one line per policy every ten seconds per instance; an outage must not flood the logs.
  const now = Date.now();
  if (now - (lastUnavailableLog.get(policy.name) ?? 0) < 10_000) return;
  lastUnavailableLog.set(policy.name, now);
  console.error(JSON.stringify({ level: "error", event: "rate_limit_unavailable", policy: policy.name, mode, name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : null }));
}

function exceeded(policy: RateLimitPolicy, resetSeconds: number): EngineError {
  const retry = Math.max(1, Math.ceil(resetSeconds));
  return new EngineError("quota_exceeded", `${MESSAGES[policy.name]} Try again in ${retry} second${retry === 1 ? "" : "s"}.`, { retryAfterSeconds: retry });
}

/**
 * The limits evaluated for one request. Collects what was actually enforced so the response can carry the
 * IETF `RateLimit-Policy` / `RateLimit` headers (draft-ietf-httpapi-ratelimit-headers) for exactly those.
 */
export class RequestLimits {
  private readonly evaluated = new Map<string, RateLimitEvaluation>();
  private readonly network: string | null;
  private readonly config: RateLimitConfig;
  constructor(private readonly store: Store, config: RateLimitConfig, headers: Headers) {
    this.config = config;
    this.network = config.enabled ? clientNetwork(headers, config.trustProxyHeaders) : null;
  }

  /** Counts `cost` requests for `subject` against `policy`. Throws `quota_exceeded` (HTTP 429) when over the limit. */
  async enforce(policy: RateLimitPolicy, subject: string, cost = 1): Promise<void> {
    if (!this.config.enabled) return;
    const key = `${policy.name}:${subject}`;
    let hit: RateLimitHit;
    try {
      hit = await this.store.consumeRateLimit(key, policy.limit, policy.windowSeconds, Math.min(Math.max(1, Math.floor(cost)), 1000));
    } catch (error) {
      if (policy.name !== "failed_auth") {
        logUnavailable(policy, "fail_open", error);
        return;
      }
      logUnavailable(policy, "local_fallback", error);
      hit = localHit(stateFor(this.store), key, policy);
    }
    this.evaluated.set(policy.name, { policy, remaining: hit.remaining, resetSeconds: hit.resetSeconds });
    if (!hit.allowed) throw exceeded(policy, hit.resetSeconds);
  }

  /** Per-network bucket. A no-op when the client network cannot be known (see `clientNetwork`). */
  async enforceNetwork(policy: RateLimitPolicy): Promise<void> {
    if (this.network) await this.enforce(policy, networkSubject(this.network));
  }

  /** Header values for the limits evaluated on this request; empty when none were (or the limiter failed open). */
  headers(): Record<string, string> {
    if (!this.evaluated.size) return {};
    const entries = [...this.evaluated.values()];
    return {
      "RateLimit-Policy": entries.map(({ policy }) => `"${policy.name}";q=${policy.limit};w=${policy.windowSeconds}`).join(", "),
      RateLimit: entries.map(({ policy, remaining, resetSeconds }) => `"${policy.name}";r=${remaining};t=${resetSeconds}`).join(", "),
    };
  }
}

/**
 * Authentication wrapped in the per-network buckets: no credential counts against `anonymous`; a refused
 * credential counts against `failed_auth` (and an over-limit network gets 429 instead of another 401).
 * A valid credential is never refused by either bucket, so people sharing a network address with a noisy
 * client (a venue NAT, say) keep working. The per-principal bucket is applied by the caller once it knows
 * the request's cost.
 */
export async function authenticateWithLimits(deps: EngineDeps, limits: RequestLimits, authorization: string | null): Promise<Principal> {
  const policies = deps.config.rateLimit;
  if (!authorization?.trim()) {
    await limits.enforceNetwork(policies.anonymous);
    return authenticate(deps, authorization);
  }
  try {
    return await authenticate(deps, authorization);
  } catch (error) {
    if (error instanceof EngineError && error.code === "unauthenticated") await limits.enforceNetwork(policies.failedAuth);
    throw error;
  }
}

/** For service credentials checked outside `authenticate` (render worker, scheduler): counts a refusal. */
export async function refuseCredential(limits: RequestLimits, config: RateLimitConfig, refusal: EngineError): Promise<never> {
  await limits.enforceNetwork(config.failedAuth);
  throw refusal;
}
