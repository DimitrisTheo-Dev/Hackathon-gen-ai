import { createHash, randomBytes } from "node:crypto";
import { EngineError, StoreConflict } from "./errors.js";
import type { EngineConfig } from "./config.js";
import { selectOne, type Row, type Store } from "./store.js";

export type Role = "owner" | "admin" | "editor" | "reviewer";
export const ALL_SCOPES = [
  "campaign:read",
  "content:edit",
  "render:write",
  "schedule:prepare",
  "schedule:approve",
  "schedule:commit",
  "billing:read",
  "billing:manage",
  "billing:checkout",
  "connections:manage",
] as const;
export type Scope = (typeof ALL_SCOPES)[number];
/** Publication approval, billing management and token administration are never delegable to an agent. */
export const AGENT_GRANTABLE_SCOPES: Scope[] = ["campaign:read", "content:edit", "render:write", "schedule:prepare", "billing:read", "billing:checkout"];
const ROLE_SCOPES: Record<Role, Scope[]> = {
  owner: [...ALL_SCOPES],
  admin: [...ALL_SCOPES],
  editor: ["campaign:read", "content:edit", "render:write", "schedule:prepare", "billing:read"],
  reviewer: ["campaign:read", "schedule:prepare", "schedule:approve", "billing:read"],
};

/** Who is calling, established only from a verified credential. Never from request bodies. */
export type Principal =
  | { kind: "human"; userId: string; email: string | null }
  | { kind: "agent"; via: "oauth"; userId: string; email: string | null; clientId: string }
  | { kind: "agent"; via: "token"; connectionId: string; orgId: string; scopes: Scope[]; displayName: string; createdBy: string };

export interface Ctx {
  principal: Principal;
  org: Row;
  role: Role | "agent";
  scopes: Set<Scope>;
  /** Stable actor identifier for audit rows. */
  actorId: string;
  actorKind: "human" | "agent";
  actorLabel: string;
  correlationId: string;
}
export interface EngineDeps {
  store: Store;
  config: EngineConfig;
  now: () => Date;
  /** Verifies a Supabase-issued access token (signature, issuer, audience, expiry). */
  verifyAccessToken: (token: string) => Promise<{ sub: string; email: string | null; clientId: string | null }>;
  fetch: typeof fetch;
}

export function requireScope(ctx: Ctx, scope: Scope) {
  if (!ctx.scopes.has(scope))
    throw new EngineError("forbidden", `This action needs the ${scope} permission, which this ${ctx.actorKind === "agent" ? "agent connection" : "role"} does not have.`);
}
export function requireHuman(ctx: Ctx, action: string) {
  if (ctx.principal.kind !== "human")
    throw new EngineError("approval_required", `${action} must be confirmed by a signed-in workspace member in the studio. Agents cannot do this.`, {
      reviewUrl: "/studio/",
    });
}

export const TOKEN_PREFIX = "fct_";
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function newAgentToken() {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export async function authenticate(deps: EngineDeps, authorization: string | null): Promise<Principal> {
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match) throw new EngineError("unauthenticated", "Sign in, or send a valid workspace token, to access this workspace.");
  const token = match[1];
  if (token.startsWith(TOKEN_PREFIX)) {
    const row = await selectOne(deps.store, "agent_connections", { token_sha256: hashToken(token) });
    if (!row || row.revoked_at || new Date(row.expires_at) <= deps.now())
      throw new EngineError("unauthenticated", "This workspace token is unknown, expired or revoked. Create a new one in the studio.");
    // Throttled last-seen marker; a failure here must not fail the request.
    if (!row.last_seen_at || deps.now().getTime() - new Date(row.last_seen_at).getTime() > 60_000)
      await deps.store.update("agent_connections", { id: row.id }, { last_seen_at: deps.now().toISOString() }).catch(() => undefined);
    return { kind: "agent", via: "token", connectionId: row.id, orgId: row.org_id, scopes: row.scopes as Scope[], displayName: row.display_name, createdBy: row.created_by };
  }
  let claims: { sub: string; email: string | null; clientId: string | null };
  try {
    claims = await deps.verifyAccessToken(token);
  } catch {
    throw new EngineError("unauthenticated", "Your session has expired or is not valid. Sign in again.");
  }
  return claims.clientId
    ? { kind: "agent", via: "oauth", userId: claims.sub, email: claims.email, clientId: claims.clientId }
    : { kind: "human", userId: claims.sub, email: claims.email };
}

function workspaceName(email: string | null) {
  const local = email?.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  return local ? `${local[0].toUpperCase()}${local.slice(1)}’s studio`.slice(0, 120) : "Personal studio";
}

/** Idempotent first-run provisioning. Safe under concurrent first requests: unique keys decide the winner. */
export async function ensurePersonalOrg(deps: EngineDeps, userId: string, email: string | null): Promise<Row> {
  const existing = await selectOne(deps.store, "organizations", { personal_owner_id: userId });
  if (existing) return existing;
  const now = deps.now().toISOString();
  let org: Row;
  try {
    org = await deps.store.insert("organizations", {
      id: crypto.randomUUID(),
      name: workspaceName(email),
      type: "personal",
      timezone: "Europe/Athens",
      personal_owner_id: userId,
      created_by: userId,
      created_at: now,
    });
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error;
    const winner = await selectOne(deps.store, "organizations", { personal_owner_id: userId });
    if (!winner) throw error;
    org = winner;
  }
  const once = async (table: string, row: Row) => {
    try {
      await deps.store.insert(table, row);
    } catch (error) {
      if (!(error instanceof StoreConflict)) throw error;
    }
  };
  await once("memberships", { org_id: org.id, user_id: userId, role: "owner", created_at: now });
  await once("brand_profiles", { org_id: org.id, name: "", description: "", rules: [], color: "#5F6C66", tone: "", audience: "", preferred_avatar_id: null, updated_at: now });
  await once("billing_state", { org_id: org.id, status: "free", plan_key: null, stripe_subscription_id: null, stripe_price_id: null, current_period_end: null, cancel_at_period_end: false, last_event_created: 0, updated_at: now });
  if (deps.config.starterCredits > 0)
    await once("credit_ledger", { id: crypto.randomUUID(), org_id: org.id, delta: deps.config.starterCredits, reason: "starter_grant", ref: "starter", created_at: now });
  return org;
}

export async function resolveContext(deps: EngineDeps, principal: Principal, requestedOrgId: string | null, correlationId: string): Promise<Ctx> {
  if (principal.kind === "agent" && principal.via === "token") {
    const org = await selectOne(deps.store, "organizations", { id: principal.orgId });
    if (!org) throw new EngineError("unauthenticated", "This workspace token no longer maps to a workspace.");
    if (requestedOrgId && requestedOrgId !== org.id) throw new EngineError("forbidden", "This token is bound to a different workspace.");
    return {
      principal,
      org,
      role: "agent",
      scopes: new Set(principal.scopes.filter((scope) => AGENT_GRANTABLE_SCOPES.includes(scope))),
      actorId: `agent:${principal.connectionId}`,
      actorKind: "agent",
      actorLabel: `${principal.displayName} (agent)`,
      correlationId,
    };
  }
  const personal = await ensurePersonalOrg(deps, principal.userId, principal.email);
  let org = personal;
  let membership: Row | null = null;
  const wanted = requestedOrgId ?? (await selectOne(deps.store, "user_state", { user_id: principal.userId }))?.last_org_id ?? null;
  if (wanted && wanted !== personal.id) {
    membership = await selectOne(deps.store, "memberships", { org_id: wanted, user_id: principal.userId });
    const candidate = membership ? await selectOne(deps.store, "organizations", { id: wanted }) : null;
    if (candidate) org = candidate;
    else if (requestedOrgId) throw new EngineError("not_found", "That workspace is not available to this account.");
  }
  membership ??= await selectOne(deps.store, "memberships", { org_id: org.id, user_id: principal.userId });
  if (!membership) throw new EngineError("not_found", "That workspace is not available to this account.");
  const role = membership.role as Role;
  const roleScopes = ROLE_SCOPES[role] ?? [];
  const agent = principal.kind === "agent";
  const scopes = agent
    ? roleScopes.filter((scope) => AGENT_GRANTABLE_SCOPES.includes(scope))
    : roleScopes.filter((scope) => scope !== "billing:checkout" || roleScopes.includes("billing:manage"));
  return {
    principal,
    org,
    role,
    scopes: new Set(scopes),
    actorId: agent ? `oauth:${principal.clientId}:${principal.userId}` : principal.userId,
    actorKind: agent ? "agent" : "human",
    actorLabel: agent ? `Connected agent for ${principal.email ?? "member"}` : (principal.email ?? "Workspace member"),
    correlationId,
  };
}

export async function listWorkspaces(deps: EngineDeps, ctx: Ctx): Promise<Array<{ id: string; name: string; role: string; type: string }>> {
  if (ctx.principal.kind === "agent" && ctx.principal.via === "token") return [{ id: ctx.org.id, name: ctx.org.name, role: "agent", type: ctx.org.type }];
  const memberships = await deps.store.select("memberships", { user_id: ctx.principal.userId });
  if (!memberships.length) return [];
  const orgs = await deps.store.select("organizations", { id: { in: memberships.map((row) => row.org_id) } });
  return orgs.map((org) => ({ id: org.id, name: org.name, type: org.type, role: memberships.find((row) => row.org_id === org.id)!.role }));
}

export async function audit(deps: EngineDeps, ctx: Ctx, event: { projectId?: string | null; action: string; objectId: string; revision?: number | null; outcome: string }) {
  await deps.store.insert("audit_events", {
    id: crypto.randomUUID(),
    org_id: ctx.org.id,
    project_id: event.projectId ?? null,
    actor: ctx.actorLabel,
    actor_kind: ctx.actorKind,
    action: event.action,
    object_id: event.objectId,
    revision: event.revision ?? null,
    outcome: event.outcome,
    correlation_id: ctx.correlationId,
    at: deps.now().toISOString(),
  });
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Idempotency for side effects. The same key with the same request replays the recorded result;
 * the same key with a different request is rejected. Shared by the studio UI and MCP tools.
 */
export async function idempotent<T>(deps: EngineDeps, ctx: Ctx, name: string, key: string, input: unknown, run: () => Promise<T>): Promise<T> {
  const requestHash = sha256Hex(canonical({ name, input }));
  const existing = await selectOne(deps.store, "operations", { org_id: ctx.org.id, key });
  if (existing) {
    if (existing.request_hash !== requestHash)
      throw new EngineError("idempotency_conflict", "This operation key was already used with different content. Use a new key for a new request.");
    if (existing.response !== null && existing.response !== undefined) return existing.response as T;
  } else {
    try {
      await deps.store.insert("operations", { org_id: ctx.org.id, key, name, request_hash: requestHash, response: null, created_at: deps.now().toISOString() });
    } catch (error) {
      if (!(error instanceof StoreConflict)) throw error;
      const raced = await selectOne(deps.store, "operations", { org_id: ctx.org.id, key });
      if (raced && raced.request_hash !== requestHash) throw new EngineError("idempotency_conflict", "This operation key was already used with different content.");
      if (raced?.response) return raced.response as T;
    }
  }
  const result = await run();
  await deps.store.update("operations", { org_id: ctx.org.id, key }, { response: result as Row });
  return result;
}
