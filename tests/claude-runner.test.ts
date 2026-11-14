import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildRunArgs, corsHeaders, createRunner, extractLoginUrl, isSubscriptionToken, keyMatches, parseRunRequest, summarizeAuth, type RunnerConfig } from "../apps/claude-runner/server";

const KEY = "k".repeat(48);
const ORIGIN = "http://127.0.0.1:5173";

// Stand-in for the Claude Code CLI: same arguments and output shapes, no network or account.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = process.env.HOME + "/fake-signed-in";
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[0] === "--version") console.log("9.9.9 (Claude Code)");
else if (args[0] === "auth" && args[1] === "status") {
  const token = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const loggedIn = token || fs.existsSync(state);
  out({ loggedIn, authMethod: token ? "oauth_token" : loggedIn ? "claude.ai" : "none", email: loggedIn ? "owner@example.com" : undefined, subscriptionType: loggedIn ? "max" : undefined, apiKeySeen: Boolean(process.env.ANTHROPIC_API_KEY), runnerKeySeen: Boolean(process.env.RUNNER_ACCESS_KEY) });
} else if (args[0] === "auth" && args[1] === "logout") { try { fs.unlinkSync(state); } catch {} }
else if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=abc\\nPaste code here if prompted > ");
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (!input.includes("\\n")) return;
    if (input.trim() === "good-code-123#abc") { fs.writeFileSync(state, "1"); console.log("Login successful."); process.exit(0); }
    console.log("OAuth error: invalid code"); process.exit(1);
  });
} else if (args[0] === "-p") {
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    const at = args.indexOf("--resume");
    const sid = at >= 0 ? args[at + 1] : "11111111-2222-3333-4444-555555555555";
    out({ type: "system", subtype: "init", session_id: sid, model: "claude-test", permissionMode: args[args.indexOf("--permission-mode") + 1], cwd: process.cwd(), apiKeySeen: Boolean(process.env.ANTHROPIC_API_KEY), runnerKeySeen: Boolean(process.env.RUNNER_ACCESS_KEY), tokenSeen: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) });
    if (prompt === "wait") { setTimeout(() => {}, 20000); return; }
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Echo" } } });
    out({ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "Echo: " + prompt }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "Echo: " + prompt, duration_ms: 5, num_turns: 1, session_id: sid });
  });
}
`;

async function startRunner() {
  const home = await mkdtemp(join(tmpdir(), "claude-runner-"));
  const bin = join(home, "fake-claude");
  await writeFile(bin, FAKE_CLAUDE);
  await chmod(bin, 0o755);
  const config: RunnerConfig = { port: 0, host: "127.0.0.1", accessKey: KEY, allowedOrigins: [ORIGIN], claudeBin: bin, homeDir: home, workspaceDir: home, dataDir: join(home, ".claude-runner"), maxRunMinutes: 1 };
  const server = createRunner(config);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit & { key?: string | null } = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { Origin: ORIGIN, ...(init.key === null ? {} : { Authorization: `Bearer ${init.key ?? KEY}` }), ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers as Record<string, string> | undefined) },
  });
  return { home, config, call, close: async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); await rm(home, { recursive: true, force: true }); } };
}
const lines = async (response: Response) => (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

test("access key check is exact and needs a bearer header", () => {
  assert.equal(keyMatches(KEY, `Bearer ${KEY}`), true);
  assert.equal(keyMatches(KEY, `bearer ${KEY}`), true);
  assert.equal(keyMatches(KEY, `Bearer ${KEY}x`), false);
  assert.equal(keyMatches(KEY, KEY), false);
  assert.equal(keyMatches(KEY, undefined), false);
  assert.equal(keyMatches("", "Bearer "), false);
});

test("CORS only answers listed origins", () => {
  assert.equal(corsHeaders(ORIGIN, [ORIGIN])?.["Access-Control-Allow-Origin"], ORIGIN);
  assert.equal(corsHeaders("https://evil.example", [ORIGIN]), null);
  assert.equal(corsHeaders(undefined, [ORIGIN]), null);
});

test("finds the sign-in link in piped and terminal output", () => {
  const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
  assert.equal(extractLoginUrl(`Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\nPaste code here if prompted > `), url);
  assert.equal(extractLoginUrl(`visit: \u001b]8;;${url}\u0007${url}\u001b]8;;\u0007\r\nPaste code`), url);
  assert.equal(extractLoginUrl("no link yet"), null);
});

test("validates run requests and keeps the prompt out of the arguments", () => {
  const request = parseRunRequest({ prompt: "--dangerously-skip-permissions hi", permissionMode: "plan", model: "sonnet", sessionId: "11111111-2222-3333-4444-555555555555" });
  const args = buildRunArgs(request);
  assert.ok(!args.some((arg) => arg.includes("hi")));
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), ["--permission-mode", "plan"]);
  assert.ok(args.includes("--resume") && args.includes("sonnet"));
  assert.equal(parseRunRequest({ prompt: "x" }).permissionMode, "acceptEdits");
  assert.throws(() => parseRunRequest({ prompt: " " }), /prompt/);
  assert.throws(() => parseRunRequest({ prompt: "x", model: "gpt" }), /Model/);
  assert.throws(() => parseRunRequest({ prompt: "x", permissionMode: "yolo" }), /Permission/);
  assert.throws(() => parseRunRequest({ prompt: "x", sessionId: "../etc" }), /session/);
});

test("token format and auth summary", () => {
  assert.equal(isSubscriptionToken(`sk-ant-oat01-${"a".repeat(40)}`), true);
  assert.equal(isSubscriptionToken(`sk-ant-api03-${"a".repeat(40)}`), false);
  assert.deepEqual(summarizeAuth({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", subscriptionType: "max" }), { loggedIn: true, authMethod: "claude.ai", email: "a@b.c", subscriptionType: "max", organization: null });
  assert.equal(summarizeAuth("nope").loggedIn, false);
});

test("runner rejects missing keys and foreign origins", async () => {
  const runner = await startRunner();
  try {
    assert.equal((await runner.call("/v1/status", { key: null })).status, 401);
    assert.equal((await runner.call("/v1/status", { key: "wrong" })).status, 401);
    assert.equal((await runner.call("/v1/status", { headers: { Origin: "https://evil.example" } })).status, 403);
    const preflight = await runner.call("/v1/run", { method: "OPTIONS", key: null });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal((await runner.call("/health", { key: null })).status, 200);
  } finally { await runner.close(); }
});

test("sign-in on the server, status, run, resume and sign-out", async () => {
  const runner = await startRunner();
  try {
    let status = await (await runner.call("/v1/status")).json();
    assert.equal(status.claudeVersion, "9.9.9");
    assert.equal(status.auth.loggedIn, false);

    const started = await (await runner.call("/v1/login/start", { method: "POST" })).json();
    assert.match(started.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    const bad = await runner.call("/v1/login/finish", { method: "POST", body: JSON.stringify({ code: "wrong-code-999" }) });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "login_failed");

    await runner.call("/v1/login/start", { method: "POST" });
    const finished = await (await runner.call("/v1/login/finish", { method: "POST", body: JSON.stringify({ code: "good-code-123#abc" }) })).json();
    assert.equal(finished.auth.loggedIn, true);
    assert.equal(finished.auth.email, "owner@example.com");

    const run = await runner.call("/v1/run", { method: "POST", body: JSON.stringify({ prompt: "hello", permissionMode: "bypassPermissions" }) });
    assert.equal(run.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    const events = await lines(run);
    assert.deepEqual(events.map((event) => event.type), ["runner", "system", "stream_event", "assistant", "result", "runner"]);
    assert.equal(events[1].permissionMode, "bypassPermissions");
    assert.equal(events.at(-1)?.code, 0);

    const resumed = await lines(await runner.call("/v1/run", { method: "POST", body: JSON.stringify({ prompt: "again", sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }) }));
    assert.equal(resumed[1].session_id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    status = await (await runner.call("/v1/auth", { method: "DELETE" })).json();
    assert.equal(status.auth.loggedIn, false);
  } finally { await runner.close(); }
});

test("pasted token is stored privately and used instead of API billing", async () => {
  const runner = await startRunner();
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-should-not-pass";
  process.env.RUNNER_ACCESS_KEY = KEY;
  try {
    const rejected = await runner.call("/v1/token", { method: "POST", body: JSON.stringify({ token: "not-a-token" }) });
    assert.equal(rejected.status, 400);
    const token = `sk-ant-oat01-${"b".repeat(60)}`;
    const saved = await (await runner.call("/v1/token", { method: "POST", body: JSON.stringify({ token }) })).json();
    assert.equal(saved.auth.authMethod, "oauth_token");
    const file = join(runner.config.dataDir, "oauth-token");
    assert.equal((await readFile(file, "utf8")).trim(), token);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const raw = await (await runner.call("/v1/status")).json();
    assert.equal(raw.tokenStored, true);
    const init = (await lines(await runner.call("/v1/run", { method: "POST", body: JSON.stringify({ prompt: "hi" }) })))[1];
    assert.deepEqual([init.apiKeySeen, init.runnerKeySeen, init.tokenSeen], [false, false, true]);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
    delete process.env.RUNNER_ACCESS_KEY;
    await runner.close();
  }
});

test("one run at a time, and stop ends it", async () => {
  const runner = await startRunner();
  try {
    const first = runner.call("/v1/run", { method: "POST", body: JSON.stringify({ prompt: "wait" }) });
    const response = await first;
    const reader = response.body!.getReader();
    await reader.read(); // started
    const busy = await runner.call("/v1/run", { method: "POST", body: JSON.stringify({ prompt: "x" }) });
    assert.equal(busy.status, 409);
    assert.equal((await (await runner.call("/v1/run/stop", { method: "POST" })).json()).stopped, true);
    let text = "";
    for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    const exit = text.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(exit.event, "exit");
    assert.equal(exit.signal, "SIGTERM");
  } finally { await runner.close(); }
});
