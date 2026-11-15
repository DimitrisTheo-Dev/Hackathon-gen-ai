import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { MemoryStore } from "../packages/engine/src/store-memory";
import { identify } from "../apps/machines/src/lib";

const KEY = "m".repeat(48);
const ALICE = "3f2c1d7e-aaaa-4bbb-8ccc-00000000a11c";
const NOW = Date.parse("2026-11-15T10:00:00.000Z");

/** Real engine, in-memory store. Tokens "user:<id>[:<oauth client>]" stand in for verified Supabase sessions. */
function engine(env: Record<string, string> = {}) {
  const deps: HttpDeps = {
    store: new MemoryStore(),
    config: loadConfig({ SUPABASE_URL: "https://project.supabase.co", APP_BASE_URL: "https://faceful.test", ...env }),
    now: () => new Date(NOW),
    verifyAccessToken: async (token) => {
      const [kind, id, client] = token.split(":");
      if (kind !== "user" || !id) throw new Error("invalid");
      return { sub: id, email: `${id}@example.com`, clientId: client ?? null };
    },
    fetch: async () => new Response("{}", { status: 500 }),
    planner: null,
  };
  const mint = async (authorization: string | null, method = "POST") => {
    const response = await handleEngineRequest(deps, new Request("https://faceful.test/v1/studio/machines/token", { method, headers: authorization ? { authorization } : {} }), "/v1/studio/machines/token");
    return { status: response!.status, body: (await response!.json()) as { token?: string; expiresAt?: string; error?: { code: string; message: string } } };
  };
  return { deps, mint };
}

test("the engine trades a signed-in session for a ten-minute machines token the gateway accepts", async () => {
  const { mint } = engine({ MACHINES_GATEWAY_KEY: `2:${KEY},1:${"o".repeat(48)}`, MACHINE_ALLOWED_USERS: `someone-else, ${ALICE}` });
  const { status, body } = await mint(`Bearer user:${ALICE}`);
  assert.equal(status, 200);
  assert.match(body.token!, new RegExp(`^fgs1\\.2\\.${ALICE}\\.\\d+\\.\\d+\\.[A-Za-z0-9_-]{43}$`));
  assert.equal(body.expiresAt, new Date(NOW + 10 * 60_000).toISOString());
  // The gateway, holding the same keyring, takes it as this user's session, and refuses it once it has expired.
  assert.deepEqual(await identify(`Bearer ${body.token}`, { session: `2:${KEY}` }, NOW + 60_000), { uid: ALICE, via: "session" });
  assert.equal(await identify(`Bearer ${body.token}`, { session: `2:${KEY}` }, NOW + 11 * 60_000), null);
});

test("no machines token for unlisted accounts, agents, anonymous callers, or an engine without the key", async () => {
  const configured = engine({ MACHINES_GATEWAY_KEY: KEY, MACHINE_ALLOWED_USERS: ALICE });
  const unlisted = await configured.mint("Bearer user:bob");
  assert.deepEqual([unlisted.status, unlisted.body.error?.code], [403, "forbidden"]);
  assert.match(unlisted.body.error!.message, /invite-only/);
  const agent = await configured.mint(`Bearer user:${ALICE}:claude-desktop`);
  assert.deepEqual([agent.status, agent.body.error?.code], [403, "approval_required"], "an OAuth agent acting for Alice can't open her machine");
  assert.equal((await configured.mint(null)).status, 401);
  assert.equal((await configured.mint(`Bearer user:${ALICE}`, "GET")).status, 404);

  const unset = await engine({ MACHINE_ALLOWED_USERS: ALICE }).mint(`Bearer user:${ALICE}`);
  assert.deepEqual([unset.status, unset.body.error?.code], [422, "unsupported"]);
  assert.equal(engine({ MACHINES_GATEWAY_KEY: "too-short", MACHINE_ALLOWED_USERS: ALICE }).deps.config.machines.gatewayKey, null);
  const nobody = await engine({ MACHINES_GATEWAY_KEY: KEY }).mint(`Bearer user:${ALICE}`);
  assert.equal(nobody.status, 403, "an empty list lets nobody in");
});
