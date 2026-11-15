import test from "node:test";
import assert from "node:assert/strict";
import { createRunnerClient, type StreamEvent } from "../apps/web/src/claude/runner";

/**
 * Live check of one real cloud machine: it wakes, Claude answers with the saved subscription sign-in, and that
 * sign-in is still there after the machine sleeps and wakes again. Skipped unless CLAUDE_MACHINE_LIVE=1:
 *   pnpm test:claude-live
 * Needs VITE_CLAUDE_GATEWAY_URL and a personal token (CLAUDE_MACHINE_TOKEN, or VITE_CLAUDE_GATEWAY_TOKEN from
 * .env.local; mint one with `node apps/machines/mint-token.mjs <user-id> 7d`). Sign in to Claude once on
 * /claude-login-test/ first. Each run uses two of the machine's six wakes an hour.
 */
const live = process.env.CLAUDE_MACHINE_LIVE === "1";
const gateway = process.env.VITE_CLAUDE_GATEWAY_URL?.trim().replace(/\/+$/, "") ?? "";
const token = (process.env.CLAUDE_MACHINE_TOKEN ?? process.env.VITE_CLAUDE_GATEWAY_TOKEN ?? "").trim();
// Node's fetch has no HTTP cache to skip; the browser-side option is dropped.
const fetcher: typeof fetch = (input, init) => fetch(input, { ...init, cache: undefined });

test("a cloud machine answers with the Claude subscription, and its sign-in survives sleep", { skip: !live && "set CLAUDE_MACHINE_LIVE=1", timeout: 6 * 60_000 }, async () => {
  assert.ok(gateway && token, "Set VITE_CLAUDE_GATEWAY_URL and CLAUDE_MACHINE_TOKEN (or VITE_CLAUDE_GATEWAY_TOKEN).");
  const client = createRunnerClient(gateway, token, fetcher);
  const machine = await client.machine();
  assert.ok(machine?.gateway, "The address answered, but it is not a machines gateway.");

  const awake = await client.status();
  assert.ok(awake.auth.loggedIn, `Claude isn't signed in on machine "${machine.user}". Open /claude-login-test/, press Connect Claude once, then run this again.`);
  assert.equal(awake.store, true, "The machine has no cloud storage, so its sign-in would not survive sleep.");

  const events: StreamEvent[] = [];
  await client.run({ prompt: "Reply with exactly the word pong and nothing else.", project: "smoke", model: "haiku", permissionMode: "plan" }, (event) => events.push(event));
  const result = events.find((event) => event.type === "result") as (StreamEvent & { is_error?: boolean; result?: string }) | undefined;
  assert.ok(result, `No result event; saw ${events.map((event) => event.type).join(", ")}`);
  assert.equal(result.is_error, false, `Claude reported an error: ${result.result}`);
  assert.match(String(result.result), /pong/i);

  assert.equal((await client.sleepMachine()).stopped, true, "The machine did not go to sleep.");
  const again = await client.status(); // wakes it from cold storage
  assert.ok(again.auth.loggedIn, "Claude's sign-in did not come back after the machine slept.");
  assert.equal(again.auth.email, awake.auth.email);
});
