import { createRemoteJWKSet, jwtVerify } from "jose";
import { loadConfig, type EngineConfig } from "./config.js";
import type { HttpDeps } from "./http.js";
import { createPlanner } from "./llm.js";
import { R2FileStore, UnconfiguredFileStore } from "./r2.js";
import { SupabaseStore } from "./store-supabase.js";

/**
 * Production wiring: Supabase Postgres + Storage with the server secret key, Supabase-issued JWTs
 * verified against the project's JWKS. Built once per warm function instance.
 */
export function createTokenVerifier(supabaseUrl: string) {
  const issuer = `${supabaseUrl}/auth/v1`;
  const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  return async (token: string) => {
    // Signature, issuer, audience and expiry are all checked; asymmetric algorithms only.
    const { payload } = await jwtVerify(token, keys, { issuer, audience: "authenticated", algorithms: ["ES256", "RS256"] });
    if (typeof payload.sub !== "string" || payload.role !== "authenticated" || payload.is_anonymous === true) throw new Error("Not a member session");
    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      // Tokens issued to an OAuth client (an external agent) carry its client_id; first-party sessions do not.
      clientId: typeof payload.client_id === "string" && payload.client_id ? payload.client_id : null,
    };
  };
}

let cached: { deps: HttpDeps; config: EngineConfig } | null = null;
export function getRuntime(env: Record<string, string | undefined> = process.env): HttpDeps {
  if (cached) return cached.deps;
  const config = loadConfig(env);
  const secretKey = env.SUPABASE_SECRET_KEY?.trim();
  if (!config.supabaseUrl || !secretKey) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set for the engine.");
  const deps: HttpDeps = {
    store: new SupabaseStore(config.supabaseUrl, secretKey),
    config,
    now: () => new Date(),
    verifyAccessToken: createTokenVerifier(config.supabaseUrl),
    fetch: globalThis.fetch,
    planner: config.llm ? createPlanner(config.llm) : null,
    files: config.r2 ? new R2FileStore(config.r2, () => new Date(), globalThis.fetch) : new UnconfiguredFileStore(),
  };
  cached = { deps, config };
  return deps;
}
