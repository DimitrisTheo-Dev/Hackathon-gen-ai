import { createHash } from "node:crypto";
import { StoreConflict } from "./errors.js";
import type { Condition, Filter, MediaStorage, Row, SelectOptions, Store } from "./store.js";

/** Mirrors the unique constraints in supabase/migrations/20261114190000_engine_core.sql. */
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
  provider_connections: [{ columns: ["org_id", "platform", "external_account_id"] }],
  agent_connections: [{ columns: ["token_sha256"] }],
  billing_customers: [{ columns: ["org_id"] }, { columns: ["stripe_customer_id"] }],
  billing_state: [{ columns: ["org_id"] }, { columns: ["stripe_subscription_id"], where: (r) => r.stripe_subscription_id != null }],
  checkout_sessions: [{ columns: ["stripe_session_id"] }, { columns: ["org_id", "idempotency_key"] }],
  stripe_events: [{ columns: ["event_id"] }],
  credit_ledger: [{ columns: ["org_id", "ref"] }],
  castroom_director_access: [{ columns: ["user_id", "workspace_id", "campaign_id"] }],
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
}
