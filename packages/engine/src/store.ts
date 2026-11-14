/**
 * Persistence boundary for the domain engine. Two implementations exist:
 * `SupabaseStore` (PostgREST with the server secret key) and `MemoryStore` (tests only).
 * Domain services never talk to a database client directly.
 */
export type Row = Record<string, any>;
export type Condition =
  | string
  | number
  | boolean
  | null
  | { in: Array<string | number> }
  | { lte: string | number }
  | { gte: string | number }
  | { lt: string | number }
  | { neq: string | number | boolean | null };
export type Filter = Record<string, Condition>;
export interface SelectOptions {
  order?: [column: string, direction: "asc" | "desc"];
  limit?: number;
}

export interface MediaStorage {
  /** Short-lived URL a renderer uses to PUT one object. */
  createUploadUrl(path: string): Promise<{ url: string; token: string | null }>;
  /** Size and content type of a stored object, or null when it does not exist. */
  stat(path: string): Promise<{ bytes: number; mime: string } | null>;
  /** SHA-256 hex digest computed from the stored bytes. */
  sha256(path: string): Promise<string>;
  /** Expiring playback URLs; a missing object maps to null. */
  signedUrls(paths: string[], ttlSeconds: number): Promise<Record<string, string | null>>;
  put(path: string, bytes: Uint8Array, mime: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Outcome of one counted request against a fixed-window limit. */
export interface RateLimitHit {
  /** True when this request still fits in the window's limit. */
  allowed: boolean;
  /** Requests left in the current window (never negative). */
  remaining: number;
  /** Seconds until the current window ends and the count starts again. */
  resetSeconds: number;
}

export interface Store {
  /** Throws `StoreConflict` on a unique violation. */
  insert<T extends Row>(table: string, row: T): Promise<T>;
  select<T extends Row = Row>(table: string, filter: Filter, options?: SelectOptions): Promise<T[]>;
  /** Conditional update. Returns the rows that matched; an empty array is a lost compare-and-swap. */
  update<T extends Row = Row>(table: string, filter: Filter, patch: Row): Promise<T[]>;
  remove(table: string, filter: Filter): Promise<number>;
  /** Atomic credit hold. Returns the new balance, or null when the balance is insufficient. Replays are no-ops. */
  holdCredits(orgId: string, amount: number, ref: string): Promise<number | null>;
  /**
   * Atomically adds `cost` to the counter for `key` in the current fixed window of `windowSeconds` and reports
   * whether the total is still within `limit`. Authoritative across function instances (one SQL statement).
   */
  consumeRateLimit(key: string, limit: number, windowSeconds: number, cost?: number): Promise<RateLimitHit>;
  readonly media: MediaStorage;
}

export async function selectOne<T extends Row = Row>(store: Store, table: string, filter: Filter): Promise<T | null> {
  const rows = await store.select<T>(table, filter, { limit: 1 });
  return rows[0] ?? null;
}
