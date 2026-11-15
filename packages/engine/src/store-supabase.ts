import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { EngineError, StoreConflict } from "./errors.js";
import type { Condition, Filter, MediaStorage, RateLimitHit, Row, SelectOptions, Store } from "./store.js";

const MEDIA_BUCKET = "media";

function applyFilter(query: any, filter: Filter) {
  for (const [column, condition] of Object.entries(filter) as Array<[string, Condition]>) {
    if (condition === null) query = query.is(column, null);
    else if (typeof condition !== "object") query = query.eq(column, condition);
    else if ("in" in condition) query = query.in(column, condition.in);
    else if ("neq" in condition) query = condition.neq === null ? query.not(column, "is", null) : query.neq(column, condition.neq);
    else if ("lte" in condition) query = query.lte(column, condition.lte);
    else if ("gte" in condition) query = query.gte(column, condition.gte);
    else query = query.lt(column, condition.lt);
  }
  return query;
}

/**
 * 22P02 (invalid_text_representation): a filter value that cannot be the column's type, e.g. an ID from a URL that
 * is not a UUID. No row can match it, so reads and conditional writes report "nothing matched" — the caller then
 * answers not_found — instead of a 503 and an error log carrying the caller's input.
 */
const UNMATCHABLE_FILTER = "22P02";

function fail(table: string, error: { code?: string; message?: string }): never {
  if (error.code === "23505") throw new StoreConflict(table);
  // Never forward database text to callers; it can name columns, constraints or tenants.
  console.error(JSON.stringify({ level: "error", event: "store_error", table, code: error.code ?? null, message: error.message ?? null }));
  throw new EngineError("provider_unavailable", "The studio database could not complete this request. Nothing was changed; try again.");
}

class SupabaseMedia implements MediaStorage {
  constructor(private readonly client: SupabaseClient) {}
  private bucket() {
    return this.client.storage.from(MEDIA_BUCKET);
  }
  async createUploadUrl(path: string) {
    const { data, error } = await this.bucket().createSignedUploadUrl(path, { upsert: true });
    if (error || !data) throw new EngineError("provider_unavailable", "Media storage could not prepare an upload.");
    return { url: data.signedUrl, token: data.token };
  }
  async stat(path: string) {
    const { data, error } = await this.bucket().info(path);
    if (error || !data) return null;
    return { bytes: Number(data.size ?? 0), mime: String(data.contentType ?? "application/octet-stream") };
  }
  async sha256(path: string) {
    const { data, error } = await this.bucket().download(path);
    if (error || !data) throw new EngineError("provider_unavailable", "The uploaded media could not be read back for verification.");
    const hash = createHash("sha256");
    // Stream rather than buffer: rendered video can be tens of megabytes.
    for await (const chunk of data.stream() as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
    return hash.digest("hex");
  }
  /**
   * The studio polls every few seconds. Re-signing on every read would hand the player a different URL each
   * time and restart playback, so a URL is reused until half of its lifetime has passed.
   */
  private readonly signed = new Map<string, { url: string; at: number }>();
  async signedUrls(paths: string[], ttlSeconds: number) {
    const result: Record<string, string | null> = Object.fromEntries(paths.map((path) => [path, null]));
    const now = Date.now();
    const missing: string[] = [];
    for (const path of paths) {
      const cached = this.signed.get(`${ttlSeconds}:${path}`);
      if (cached && now - cached.at < (ttlSeconds * 1000) / 2) result[path] = cached.url;
      else missing.push(path);
    }
    if (!missing.length) return result;
    const { data, error } = await this.bucket().createSignedUrls(missing, ttlSeconds);
    if (error || !data) return result;
    for (const entry of data)
      if (entry.path && entry.signedUrl && !entry.error) {
        result[entry.path] = entry.signedUrl;
        this.signed.set(`${ttlSeconds}:${entry.path}`, { url: entry.signedUrl, at: now });
      }
    if (this.signed.size > 2000) this.signed.clear();
    return result;
  }
  async put(path: string, bytes: Uint8Array, mime: string) {
    const { error } = await this.bucket().upload(path, bytes, { contentType: mime, upsert: false });
    if (error) throw new EngineError("provider_unavailable", "Media storage rejected the upload.");
  }
  async remove(path: string) {
    for (const key of this.signed.keys()) if (key.endsWith(`:${path}`)) this.signed.delete(key);
    await this.bucket().remove([path]);
  }
}

export class SupabaseStore implements Store {
  readonly media: MediaStorage;
  private readonly client: SupabaseClient;
  /** `fetchImpl` is a test seam only; production uses the platform fetch. */
  constructor(url: string, secretKey: string, fetchImpl?: typeof fetch) {
    this.client = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}) });
    this.media = new SupabaseMedia(this.client);
  }
  /** Service client for Auth verification of opaque sessions. Not exposed to domain services. */
  get admin() {
    return this.client;
  }
  async insert<T extends Row>(table: string, row: T): Promise<T> {
    const { data, error } = await this.client.from(table).insert(row).select().single();
    if (error) fail(table, error);
    return data as T;
  }
  async select<T extends Row = Row>(table: string, filter: Filter, options: SelectOptions = {}): Promise<T[]> {
    let query = applyFilter(this.client.from(table).select(options.columns?.join(",") ?? "*"), filter);
    if (options.order) query = query.order(options.order[0], { ascending: options.order[1] === "asc" });
    query = query.limit(options.limit ?? 1000);
    const { data, error } = await query;
    if (error?.code === UNMATCHABLE_FILTER) return [];
    if (error) fail(table, error);
    return (data ?? []) as T[];
  }
  async update<T extends Row = Row>(table: string, filter: Filter, patch: Row): Promise<T[]> {
    if (!Object.keys(filter).length) throw new Error("Refusing an unfiltered update");
    // Not masked here: a 22P02 could come from the patch values, which would be a real bug. Every engine write
    // reads its row through select() first, so an unmatchable ID is already answered as not_found there.
    const { data, error } = await applyFilter(this.client.from(table).update(patch), filter).select();
    if (error) fail(table, error);
    return (data ?? []) as T[];
  }
  async remove(table: string, filter: Filter): Promise<number> {
    if (!Object.keys(filter).length) throw new Error("Refusing an unfiltered delete");
    const { data, error } = await applyFilter(this.client.from(table).delete(), filter).select();
    if (error?.code === UNMATCHABLE_FILTER) return 0;
    if (error) fail(table, error);
    return (data ?? []).length;
  }
  async holdCredits(orgId: string, amount: number, ref: string): Promise<number | null> {
    const { data, error } = await this.client.rpc("engine_hold_credits", { p_org: orgId, p_amount: amount, p_ref: ref });
    if (error) fail("credit_ledger", error);
    return data === null || data === undefined ? null : Number(data);
  }
  async consumeRateLimit(key: string, limit: number, windowSeconds: number, cost = 1): Promise<RateLimitHit> {
    // One statement in Postgres (engine_rate_limit_hit): the window is computed from the database clock, so
    // every function instance counts into the same bucket regardless of its own clock.
    const { data, error } = await this.client.rpc("engine_rate_limit_hit", { p_key: key, p_limit: limit, p_window_seconds: windowSeconds, p_cost: cost });
    // The caller decides how to degrade (fail open, or a local fallback). Nothing about the database is forwarded.
    if (error) throw new Error(`rate limiter unavailable (${error.code ?? "unknown"})`);
    const row = (Array.isArray(data) ? data[0] : data) as { allowed?: unknown; remaining?: unknown; reset_seconds?: unknown } | null;
    if (!row || typeof row.allowed !== "boolean") throw new Error("rate limiter returned no result");
    return { allowed: row.allowed, remaining: Math.max(0, Number(row.remaining) || 0), resetSeconds: Math.max(0, Number(row.reset_seconds) || 0) };
  }
}
