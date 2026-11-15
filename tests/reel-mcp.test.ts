import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest } from "../packages/engine/src/mcp";
import { engine, seed, sha256 } from "./reel-support";

/** The reel flow exactly as a Claude Code agent on a VPS drives it: MCP with a scoped workspace token. */
async function tool(env: ReturnType<typeof engine>, token: string, name: string, args: Record<string, unknown>) {
  const response = (await handleMcpRequest(
    env.deps,
    new Request("https://faceful.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    "/mcp",
  ))!;
  assert.equal(response.status, 200);
  const { result } = (await response.json()) as { result: { isError?: boolean; structuredContent: any } };
  return result;
}

test("an agent saves drafts, uploads a voice take, builds the timeline and queues a render through MCP", async () => {
  const env = engine();
  const { ctx, campaign, item } = await seed(env);
  const token = await env.agentToken(ctx, ["campaign:read", "content:edit", "render:write"]);

  const script = await tool(env, token, "save_text_draft", { projectId: campaign.id, itemId: item.id, kind: "script", name: "Script", format: "markdown", text: "Your first scan is at week six." });
  assert.equal(script.isError, undefined);
  assert.equal(script.structuredContent.file.kind, "script");

  const voice = new Uint8Array(4096).fill(3);
  const ticket = await tool(env, token, "request_file_upload", { projectId: campaign.id, itemId: item.id, kind: "voice", name: "Voice take", mime: "audio/wav", bytes: voice.byteLength, sha256: sha256(voice), durationSeconds: 6.2, meta: { provider: "cartesia" } });
  assert.equal(ticket.structuredContent.upload.method, "PUT");
  assert.ok(ticket.structuredContent.upload.headers["x-amz-checksum-sha256"]);
  await env.files.put(`orgs/${ctx.org.id}/projects/${campaign.id}/files/${sha256(voice)}.wav`, voice, "audio/wav");
  const ready = await tool(env, token, "complete_file_upload", { fileId: ticket.structuredContent.file.id });
  assert.equal(ready.structuredContent.file.state, "ready");

  const timeline = await tool(env, token, "get_video_timeline", { itemId: item.id });
  const composition = timeline.structuredContent.composition;
  composition.audio = [{ id: "voice-1", start: 0, end: 6.2, source: { kind: "file", fileId: ready.structuredContent.file.id }, in: 0, role: "voice", volume: 1, fadeIn: 0, fadeOut: 0.2, loop: false }];
  composition.video[0].volume = 0;
  composition.transcript = { language: "en", sourceFileId: null, words: [{ t: "Your", start: 0.1, end: 0.3 }, { t: "first", start: 0.32, end: 0.6 }] };
  const saved = await tool(env, token, "save_video_timeline", { itemId: item.id, expectedRevision: 0, composition });
  assert.equal(saved.isError, undefined, JSON.stringify(saved.structuredContent));
  assert.equal(saved.structuredContent.revision, 1);
  assert.match(saved.structuredContent.studioUrl, /view=video/);

  const stale = await tool(env, token, "save_video_timeline", { itemId: item.id, expectedRevision: 0, composition });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.code, "revision_conflict");

  const queued = await tool(env, token, "queue_video_render", { itemId: item.id, expectedRevision: 1 });
  assert.equal(queued.structuredContent.render.state, "queued");
  const renders = await tool(env, token, "get_video_renders", { itemId: item.id });
  assert.equal(renders.structuredContent.renders.length, 1);
  const files = await tool(env, token, "list_draft_files", { projectId: campaign.id });
  assert.deepEqual(files.structuredContent.files.map((file: { kind: string }) => file.kind).sort(), ["script", "voice"]);
});

test("an agent token without render:write can edit the timeline but not render it", async () => {
  const env = engine();
  const { ctx, item } = await seed(env);
  const token = await env.agentToken(ctx, ["campaign:read", "content:edit"]);
  const timeline = await tool(env, token, "get_video_timeline", { itemId: item.id });
  const saved = await tool(env, token, "save_video_timeline", { itemId: item.id, expectedRevision: 0, composition: timeline.structuredContent.composition });
  assert.equal(saved.structuredContent.revision, 1);
  const refused = await tool(env, token, "queue_video_render", { itemId: item.id, expectedRevision: 1 });
  assert.equal(refused.structuredContent.code, "forbidden");
});
