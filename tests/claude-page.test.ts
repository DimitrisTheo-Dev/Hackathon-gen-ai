import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRunnerUrl, readNdjson, type StreamEvent } from "../apps/web/src/claude/runner";
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
