import { createHash } from "node:crypto";
import { StoreConflict } from "./errors.js";
import type { Condition, Filter, MediaStorage, RateLimitHit, Row, SelectOptions, Store } from "./store.js";

/** Mirrors the unique constraints in supabase/migrations (engine core, socials, personas and video compositions). */
const uniques: Record<string, Array<{ columns: string[]; where?: (row: Row) => boolean }>> = {
  organizations: [{ columns: ["id"] }, { columns: ["personal_owner_id"], where: (r) => r.personal_owner_id != null }],
  memberships: [{ columns: ["org_id", "user_id"] }],
  user_state: [{ columns: ["user_id"] }],
  brand_profiles: [{ columns: ["org_id"] }],
  content_versions: [{ columns: ["item_id", "revision"] }],
  media_assets: [{ columns: ["storage_path"] }],
  render_jobs: [
    { columns: ["org_id", "item_id", "revision", "idempotency_key"] },
    { columns: ["item_id", "revision"], where: (r) => ["queued", "running", "cancel_requested"].includes(r.state) },
  ],
  operations: [{ columns: ["org_id", "key"] }],
  publish_jobs: [{ columns: ["item_id", "revision", "platform", "account_id", "scheduled_at"] }],
  provider_connections: [{ columns: ["org_id", "provider", "platform", "external_account_id"] }],
  social_events: [{ columns: ["org_id", "platform", "type", "external_id"] }],
  agent_connections: [{ columns: ["token_sha256"] }],
  billing_customers: [{ columns: ["org_id"] }, { columns: ["stripe_customer_id"] }],
  billing_state: [{ columns: ["org_id"] }, { columns: ["stripe_subscription_id"], where: (r) => r.stripe_subscription_id != null }],
  checkout_sessions: [{ columns: ["stripe_session_id"] }, { columns: ["org_id", "idempotency_key"] }],
  stripe_events: [{ columns: ["event_id"] }],
  credit_ledger: [{ columns: ["org_id", "ref"] }],
  castroom_director_access: [{ columns: ["user_id", "workspace_id", "campaign_id"] }],
  // supabase/migrations/20261115130000_personas.sql: one consent backs at most one persona.
  personas: [{ columns: ["consent_id"], where: (r) => r.consent_id != null }],
  video_compositions: [{ columns: ["org_id", "item_id"] }],
  project_files: [{ columns: ["org_id", "project_id", "item_id", "name", "version"] }],
  // supabase/migrations/20261115130500_clone_jobs.sql
  clone_jobs: [{ columns: ["id"] }, { columns: ["org_id", "idempotency_key"] }],
  // supabase/migrations/20261115160000_products_reviews.sql: one product per stored photo.
  brand_products: [{ columns: ["image_key"], where: (r) => r.image_key != null }],
};

function matches(row: Row, filter: Filter): boolean {
  return Object.entries(filter).every(([column, condition]: [string, Condition]) => {
    const value = row[column] ?? null;
    if (condition === null || typeof condition !== "object") return value === condition;
    if ("in" in condition) return condition.in.includes(value);
    if ("neq" in condition) return value !== condition.neq;
    if (value === null) return false;
    if ("lte" in condition) return value <= condition.lte;
    if ("gte" in condition) return value >= condition.gte;
    return value < condition.lt;
  });
}

export class MemoryMedia implements MediaStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  async createUploadUrl(path: string) {
    return { url: `memory://upload/${path}`, token: null };
  }
  async stat(path: string) {
    const object = this.objects.get(path);
    return object ? { bytes: object.bytes.byteLength, mime: object.mime } : null;
  }
  async sha256(path: string) {
    const object = this.objects.get(path);
    if (!object) throw new Error("Object not found");
    return createHash("sha256").update(object.bytes).digest("hex");
  }
  async signedUrls(paths: string[], ttlSeconds: number) {
    return Object.fromEntries(paths.map((path) => [path, this.objects.has(path) ? `https://media.test/${path}?ttl=${ttlSeconds}` : null]));
  }
  async put(path: string, bytes: Uint8Array, mime: string) {
    this.objects.set(path, { bytes, mime });
  }
  async remove(path: string) {
    this.objects.delete(path);
  }
}

/** Test-only store. Single-threaded JS makes each method atomic, matching one SQL statement. */
export class MemoryStore implements Store {
  readonly tables = new Map<string, Row[]>();
  readonly media = new MemoryMedia();
  private rows(table: string) {
    let rows = this.tables.get(table);
    if (!rows) this.tables.set(table, (rows = []));
    return rows;
  }
  private assertUnique(table: string, candidate: Row, ignore?: Row) {
    for (const rule of uniques[table] ?? []) {
      if (rule.where && !rule.where(candidate)) continue;
      const clash = this.rows(table).some(
        (row) => row !== ignore && (!rule.where || rule.where(row)) && rule.columns.every((column) => row[column] === candidate[column]),
      );
      if (clash) throw new StoreConflict(table);
    }
  }
  async insert<T extends Row>(table: string, row: T): Promise<T> {
    const stored = structuredClone(row);
    this.assertUnique(table, stored);
    this.rows(table).push(stored);
    return structuredClone(stored);
  }
  async select<T extends Row = Row>(table: string, filter: Filter, options: SelectOptions = {}): Promise<T[]> {
    let result = this.rows(table).filter((row) => matches(row, filter));
    if (options.order) {
      const [column, direction] = options.order;
      result = [...result].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (direction === "asc" ? 1 : -1));
    }
    if (options.limit !== undefined) result = result.slice(0, options.limit);
    return structuredClone(result) as T[];
  }
  async update<T extends Row = Row>(table: string, filter: Filter, patch: Row): Promise<T[]> {
    const updated: Row[] = [];
    for (const row of this.rows(table).filter((candidate) => matches(candidate, filter))) {
      const next = { ...row, ...structuredClone(patch) };
      this.assertUnique(table, next, row);
      Object.assign(row, next);
      updated.push(structuredClone(row));
    }
    return updated as T[];
  }
  async remove(table: string, filter: Filter): Promise<number> {
    const rows = this.rows(table);
    const keep = rows.filter((row) => !matches(row, filter));
    this.tables.set(table, keep);
    return rows.length - keep.length;
  }
  async holdCredits(orgId: string, amount: number, ref: string): Promise<number | null> {
    const ledger = this.rows("credit_ledger").filter((row) => row.org_id === orgId);
    const balance = ledger.reduce((sum, row) => sum + row.delta, 0);
    if (ledger.some((row) => row.ref === ref)) return balance;
    if (balance < amount) return null;
    this.rows("credit_ledger").push({ id: crypto.randomUUID(), org_id: orgId, delta: -amount, reason: "render_hold", ref, created_at: new Date().toISOString() });
    return balance - amount;
  }

  /** Fixed-window buckets keyed by (key, window start), mirroring `rate_limit_buckets`. */
  readonly rateLimitBuckets = new Map<string, { key: string; windowStart: number; count: number; expiresAt: number }>();
  /** The database clock in production; tests point this at their own controllable clock. */
  clock: () => Date = () => new Date();
  async consumeRateLimit(key: string, limit: number, windowSeconds: number, cost = 1): Promise<RateLimitHit> {
    // Same argument checks as engine_rate_limit_hit, so a bad caller fails in tests the way it would in SQL.
    if (!key || key.length > 200) throw new Error("invalid rate limit key");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) throw new Error("invalid rate limit");
    if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86_400) throw new Error("invalid rate limit window");
    if (!Number.isInteger(cost) || cost < 1 || cost > 1000) throw new Error("invalid rate limit cost");
    const now = this.clock().getTime();
    const windowMs = windowSeconds * 1000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const id = `${key}\u0000${windowStart}`;
    const bucket = this.rateLimitBuckets.get(id) ?? { key, windowStart, count: 0, expiresAt: windowStart + windowMs };
    bucket.count += cost;
    this.rateLimitBuckets.set(id, bucket);
    // Housekeeping like the SQL function: each call removes up to 20 expired buckets.
    let pruned = 0;
    for (const [other, entry] of this.rateLimitBuckets) {
      if (pruned >= 20) break;
      if (entry.expiresAt < now) {
        this.rateLimitBuckets.delete(other);
        pruned++;
      }
    }
    return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), resetSeconds: Math.ceil((bucket.expiresAt - now) / 1000) };
  }
}
