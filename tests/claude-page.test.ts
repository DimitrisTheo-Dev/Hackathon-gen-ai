import test from "node:test";
import assert from "node:assert/strict";
import { codeFitsLogin, createMachineTokenSource, createRunnerClient, isCodeForLogin, normalizeRunnerUrl, readNdjson, RunnerError, type StreamEvent } from "../apps/web/src/claude/runner";
import { addUserPrompt, applyEvent, emptyTranscript, summarizeToolInput } from "../apps/web/src/claude/transcript";

test("runner address: https anywhere, http only for this computer", () => {
  assert.equal(normalizeRunnerUrl("claude.example.com"), "https://claude.example.com");
  assert.equal(normalizeRunnerUrl("https://claude.example.com/"), "https://claude.example.com");
  assert.equal(normalizeRunnerUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(() => normalizeRunnerUrl("http://claude.example.com"), /https/);
  assert.throws(() => normalizeRunnerUrl("https://user:pass@claude.example.com"), /credentials/);
  assert.throws(() => normalizeRunnerUrl("https://claude.example.com/?key=1"), /credentials/);
});

test("NDJSON reader survives split chunks", async () => {
  const encoder = new TextEncoder();
  const parts = ['{"type":"a"}\n{"ty', 'pe":"b"}\n', 'not json\n{"type":"c"}'];
  const stream = new ReadableStream<Uint8Array>({ start(controller) { parts.forEach((part) => controller.enqueue(encoder.encode(part))); controller.close(); } });
  const seen: string[] = [];
  await readNdjson(stream, (value) => seen.push(value.type));
  assert.deepEqual(seen, ["a", "b", "c"]);
});

test("transcript folds a Claude Code run", () => {
  const events: StreamEvent[] = [
    { type: "system", subtype: "init", session_id: "sid-1", model: "claude-test" },
    { type: "stream_event", event: { type: "message_start" } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Let me " } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "check." } } },
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Let me check." }] } },
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }] } },
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }] } },
    { type: "assistant", parent_tool_use_id: "t1", message: { id: "sub", content: [{ type: "text", text: "subagent chatter" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "README.md" }] }] } },
    { type: "result", subtype: "success", is_error: false, result: "Done.", duration_ms: 1234, num_turns: 2, session_id: "sid-1" },
    { type: "runner", event: "exit", code: 0 },
  ];
  let state = addUserPrompt(emptyTranscript(), "list files");
  let sawLive = false;
  for (const event of events) { state = applyEvent(state, event); sawLive ||= state.live === "Let me check."; }
  assert.ok(sawLive);
  assert.equal(state.live, "");
  assert.equal(state.sessionId, "sid-1");
  assert.equal(state.model, "claude-test");
  assert.deepEqual(state.items.map((item) => item.kind), ["user", "assistant", "tool", "result"]);
  const tool = state.items[2];
  assert.ok(tool.kind === "tool" && tool.summary === "ls -la" && tool.result === "README.md" && !tool.isError);
  const result = state.items[3];
  assert.ok(result.kind === "result" && result.ok && result.durationMs === 1234 && result.turns === 2);
});

test("errors and stops become readable notices", () => {
  let state = applyEvent(emptyTranscript(), { type: "assistant", message: { id: "x", model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
  state = applyEvent(state, { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
  assert.equal(state.items.length, 1);
  assert.ok(state.items[0].kind === "result" && !state.items[0].ok && state.items[0].text.includes("Not logged in"));
  state = applyEvent(emptyTranscript(), { type: "runner", event: "exit", code: null, signal: "SIGTERM" });
  assert.ok(state.items[0].kind === "notice" && !state.items[0].error);
  state = applyEvent(emptyTranscript(), { type: "runner", event: "exit", code: 1, stderr: "boom" });
  assert.ok(state.items[0].kind === "notice" && state.items[0].error && state.items[0].text === "boom");
});

test("tool summaries prefer the meaningful field", () => {
  assert.equal(summarizeToolInput("Read", { file_path: "/home/node/work/a.ts" }), "/home/node/work/a.ts");
  assert.equal(summarizeToolInput("TodoWrite", { todos: [1, 2] }), "2 tasks");
  assert.equal(summarizeToolInput("Other", {}), "");
});

test("cloud saves and restores show up as quiet notes", () => {
  let state = applyEvent(emptyTranscript(), { type: "runner", event: "started", project: "demo", restored: true });
  assert.ok(state.items[0].kind === "notice" && !state.items[0].error && state.items[0].text.includes("back from your cloud folder"));
  state = applyEvent(emptyTranscript(), { type: "runner", event: "started", project: "demo", restored: false });
  assert.equal(state.items.length, 0);
  state = applyEvent(emptyTranscript(), { type: "runner", event: "saved", save: { key: "projects/demo/autosave.tar.gz", files: 1 } });
  assert.ok(state.items[0].kind === "notice" && !state.items[0].error && state.items[0].text === "Saved to your cloud folder · 1 file.");
  state = applyEvent(emptyTranscript(), { type: "runner", event: "save_failed", message: "Cloud storage answered 500." });
  assert.ok(state.items[0].kind === "notice" && state.items[0].error && state.items[0].text === "Cloud storage answered 500.");
});

test("the gateway gets a machines token from the engine, never the Faceful session", async () => {
  let clock = Date.parse("2026-11-15T10:00:00.000Z");
  let session: string | null = "session-a";
  const calls: { url: string; authorization: string | null }[] = [];
  const engine = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ url: String(input), authorization });
    if (authorization === "Bearer session-b") return Response.json({ error: { code: "forbidden", message: "Cloud machines are invite-only for now." } }, { status: 403 });
    return Response.json({ token: `fgs1.token-${calls.length}`, expiresAt: new Date(clock + 600_000).toISOString() });
  }) as typeof fetch;
  const token = createMachineTokenSource("https://faceful.test/", async () => session, engine, () => clock);

  assert.deepEqual(await Promise.all([token(), token()]), ["fgs1.token-1", "fgs1.token-1"], "concurrent calls share one request");
  assert.deepEqual(calls, [{ url: "https://faceful.test/v1/studio/machines/token", authorization: "Bearer session-a" }]);
  clock += 8 * 60_000;
  assert.equal(await token(), "fgs1.token-1", "kept while it has more than a minute left");
  clock += 60_000;
  assert.equal(await token(), "fgs1.token-2");

  // What the gateway receives: the machines token. A refusal from the engine reaches the page as itself.
  const seen: string[] = [];
  const gateway = (async (_input: RequestInfo | URL, init?: RequestInit) => { seen.push(new Headers(init?.headers).get("authorization") ?? ""); return Response.json({ ok: true }); }) as typeof fetch;
  await createRunnerClient("https://machines.test", token, gateway).cancelLogin();
  assert.deepEqual(seen, ["Bearer fgs1.token-2"]);
  session = "session-b";
  await assert.rejects(createRunnerClient("https://machines.test", token, gateway).cancelLogin(), (error: unknown) => error instanceof RunnerError && error.status === 403 && /invite-only/.test(error.message));
  assert.equal(seen.length, 1, "nothing reaches the gateway without a token");
  session = null;
  await assert.rejects(token(), (error: unknown) => error instanceof RunnerError && error.status === 401);
  const offline = createMachineTokenSource("https://faceful.test", async () => "session-a", (async () => { throw new TypeError("offline"); }) as typeof fetch);
  await assert.rejects(offline(), (error: unknown) => error instanceof RunnerError && error.code === "unreachable");
});

test("a code from Claude's page must belong to the sign-in in progress", () => {
  const login = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=STATE_abc123";
  assert.equal(codeFitsLogin("AbCdEf0123456789#STATE_abc123", login), true);
  assert.equal(codeFitsLogin("AbCdEf0123456789#OLDSTATE", login), false, "a code from an earlier attempt");
  assert.equal(codeFitsLogin("AbCdEf0123456789", login), true, "no state part: the machine decides");
  // Read from the clipboard without a paste only when it is exactly this sign-in's code.
  assert.equal(isCodeForLogin(" AbCdEf0123456789#STATE_abc123\n", login), true);
  assert.equal(isCodeForLogin("AbCdEf0123456789", login), false);
  assert.equal(isCodeForLogin("AbCdEf0123456789#OLDSTATE", login), false);
  assert.equal(isCodeForLogin("some notes #STATE_abc123", login), false, "copied prose with spaces");
  assert.equal(isCodeForLogin("x#STATE_abc123", login), false, "too short to be a code");
});
