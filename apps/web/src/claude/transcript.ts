// Folds Claude Code stream-json events into a readable transcript.
import type { StreamEvent } from "./runner";

export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; result?: string; isError?: boolean }
  | { kind: "result"; id: string; ok: boolean; text: string; durationMs?: number; turns?: number }
  | { kind: "notice"; id: string; text: string; error: boolean };

export type Transcript = { items: TranscriptItem[]; live: string; sessionId: string | null; model: string | null };
export const emptyTranscript = (): Transcript => ({ items: [], live: "", sessionId: null, model: null });

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function summarizeToolInput(name: string, input: unknown): string {
  const value = record(input);
  const pick = (...keys: string[]) => keys.map((key) => value[key]).find((item) => typeof item === "string" && item) as string | undefined;
  const direct = pick("command", "file_path", "notebook_path", "pattern", "url", "query", "description", "prompt", "skill");
  if (direct) return clip(direct.replace(/\s+/g, " ").trim(), 220);
  if (name === "TodoWrite" && Array.isArray(value.todos)) return `${value.todos.length} task${value.todos.length === 1 ? "" : "s"}`;
  const json = JSON.stringify(input ?? {});
  return json === "{}" ? "" : clip(json, 220);
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof record(part).text === "string" ? (record(part).text as string) : record(part).type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
  return "";
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

export function addUserPrompt(state: Transcript, text: string): Transcript {
  return { ...state, items: [...state.items, { kind: "user", id: nextId("user"), text }], live: "" };
}
export function addNotice(state: Transcript, text: string, error = true): Transcript {
  return { ...state, items: [...state.items, { kind: "notice", id: nextId("notice"), text, error }], live: "" };
}

export function applyEvent(state: Transcript, event: StreamEvent): Transcript {
  // Subagent traffic carries a parent tool id; keep the main conversation readable.
  if (event.parent_tool_use_id) return state;
  switch (event.type) {
    case "system": {
      if (event.subtype !== "init") return state;
      return { ...state, sessionId: typeof event.session_id === "string" ? event.session_id : state.sessionId, model: typeof event.model === "string" ? event.model : state.model };
    }
    case "stream_event": {
      const inner = record(event.event);
      const delta = record(inner.delta);
      if (inner.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") return { ...state, live: state.live + delta.text };
      if (inner.type === "message_start") return { ...state, live: "" };
      return state;
    }
    case "assistant": {
      const message = record(event.message);
      // CLI-made error stand-ins repeat the final result's text; show that once, as the result.
      if (message.model === "<synthetic>") return { ...state, live: "" };
      const messageId = typeof message.id === "string" ? message.id : nextId("msg");
      const blocks = (Array.isArray(message.content) ? message.content : []) as Block[];
      let items = state.items;
      let committedText = false;
      blocks.forEach((block, index) => {
        if (block.type === "text" && block.text?.trim()) {
          const id = `${messageId}:text:${block.text.length}:${index}`;
          if (!items.some((item) => item.kind === "assistant" && item.id.startsWith(`${messageId}:`) && item.text === block.text)) items = [...items, { kind: "assistant", id, text: block.text }];
          committedText = true;
        }
        if (block.type === "tool_use" && block.id && !items.some((item) => item.id === block.id)) {
          const name = block.name ?? "Tool";
          items = [...items, { kind: "tool", id: block.id, name, summary: summarizeToolInput(name, block.input) }];
        }
      });
      return { ...state, items, live: committedText ? "" : state.live };
    }
    case "user": {
      const blocks = (Array.isArray(record(event.message).content) ? record(event.message).content : []) as Block[];
      let items = state.items;
      for (const block of blocks) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        items = items.map((item) => (item.kind === "tool" && item.id === block.tool_use_id ? { ...item, result: clip(resultText(block.content), 4000), isError: block.is_error === true } : item));
      }
      return { ...state, items };
    }
    case "result": {
      const ok = event.is_error !== true && event.subtype === "success";
      const text = typeof event.result === "string" ? event.result : ok ? "" : String(event.subtype ?? "error").replace(/_/g, " ");
      return {
        ...state,
        live: "",
        sessionId: typeof event.session_id === "string" ? event.session_id : state.sessionId,
        items: [...state.items, { kind: "result", id: nextId("result"), ok, text, durationMs: typeof event.duration_ms === "number" ? event.duration_ms : undefined, turns: typeof event.num_turns === "number" ? event.num_turns : undefined }],
      };
    }
    case "runner": {
      if (event.event === "error" && typeof event.message === "string") return addNotice(state, event.message);
      if (event.event === "exit" && event.code !== 0) {
        const finished = state.items.at(-1)?.kind === "result";
        if (event.signal === "SIGTERM") return addNotice({ ...state, live: "" }, "Run stopped.", false);
        if (!finished) return addNotice(state, typeof event.stderr === "string" && event.stderr ? clip(event.stderr, 600) : "Claude Code stopped unexpectedly.");
      }
      return state;
    }
    default:
      return state;
  }
}
