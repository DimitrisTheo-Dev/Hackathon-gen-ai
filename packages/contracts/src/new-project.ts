import { z } from "zod";

/**
 * The guided "New project" flow: describe → style → presenter → script → record → preview.
 * Two engine calls belong to it alone: an AI script draft that saves nothing, and a recording upload that
 * streams a take to storage in parts while the person is still speaking.
 */
const idSchema = z.string().min(1).max(160);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase hex SHA-256");

/** Who appears in the video. `persona` and `avatar` are AI presenters; `voice` and `camera` are the person's own take. */
export const PRESENTER_MODES = ["persona", "avatar", "voice", "camera", "none"] as const;
export const presenterModeSchema = z.enum(PRESENTER_MODES);
export type PresenterMode = z.infer<typeof presenterModeSchema>;

export const SCRIPT_BRIEF_MAX = 5000;
export const SCRIPT_BEATS_MAX = 12;
export const scriptBeatSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    /** Hook, a point, a call to action: a short name for the beat, shown above its line. */
    label: z.string().trim().max(40),
    /** Exactly what is said. */
    text: z.string().trim().max(600),
  })
  .strict();
export type ScriptBeat = z.infer<typeof scriptBeatSchema>;

export const draftScriptInputSchema = z
  .object({
    brief: z.string().trim().min(1).max(SCRIPT_BRIEF_MAX),
    language: z.string().min(2).max(12),
    /** Target length of the finished video. */
    seconds: z.number().int().min(5).max(180),
    platform: z.enum(["instagram", "tiktok", "youtube"]).nullable().default(null),
    /** A library template (the chosen style), or null for a plain presenter video. */
    templateId: idSchema.nullable().default(null),
    presenter: presenterModeSchema,
    /** The current script, when this is a rewrite. */
    beats: z.array(scriptBeatSchema).max(SCRIPT_BEATS_MAX).nullable().default(null),
    /** What to change ("shorter", "more casual"), or null for a first draft. */
    instruction: z.string().trim().max(1000).nullable().default(null),
    /** Rewrite only this beat; the others come back unchanged. */
    beatId: z.string().max(40).nullable().default(null),
    operationKey: z.uuid(),
  })
  .strict();
export type DraftScriptInput = z.input<typeof draftScriptInputSchema>;

export const draftScriptResultSchema = z.object({
  /** "ai": a model wrote it. "basic": no model is connected; the person's own description was split into lines. */
  mode: z.enum(["ai", "basic"]),
  title: z.string().min(1).max(120),
  beats: z.array(scriptBeatSchema).min(1).max(SCRIPT_BEATS_MAX),
  /** One or two sentences to the person about what was written or changed. */
  reply: z.string().max(1000),
});
export type DraftScriptResult = z.infer<typeof draftScriptResultSchema>;

/** The words a beat list speaks, one beat per paragraph. */
export function scriptFromBeats(beats: Array<{ text: string }>): string {
  return beats
    .map((beat) => beat.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Splits a person's own words into speakable lines, one sentence or two per line. Writes nothing new. */
export function beatsFromText(text: string): ScriptBeat[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?;…])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const lines: string[] = [];
  for (const sentence of sentences) {
    const previous = lines[lines.length - 1];
    // Very short sentences join the one before, so a line is something worth saying on its own.
    if (previous && (previous.split(" ").length < 6 || lines.length >= SCRIPT_BEATS_MAX)) lines[lines.length - 1] = `${previous} ${sentence}`;
    else lines.push(sentence);
  }
  return (lines.length ? lines : [text.trim() || "…"]).slice(0, SCRIPT_BEATS_MAX).map((line, index) => ({ id: `beat-${index + 1}`, label: `Line ${index + 1}`, text: line.slice(0, 600) }));
}

/** The first words of a description, as a working title. */
export function workingTitle(text: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ");
  return (words.replace(/[.,;:!?…]+$/, "") || "New video").slice(0, 120);
}

/* ───────────────────────── recorded takes ───────────────────────── */

/** Every part but the last has exactly this size (R2 needs equal parts of at least 5 MiB). */
export const TAKE_PART_BYTES = 8 * 1024 * 1024;
export const TAKE_MAX_PARTS = 120;
export const TAKE_MIMES = ["audio/webm", "audio/mp4", "audio/ogg", "video/webm", "video/mp4"] as const;
export const startTakeInputSchema = z
  .object({
    campaignId: idSchema,
    itemId: idSchema.nullable().default(null),
    /** `voice` for a voice-only take, `avatar_clip` for a camera take that stands in for the presenter. */
    kind: z.enum(["voice", "avatar_clip"]),
    mime: z.enum(TAKE_MIMES),
    name: z.string().trim().min(1).max(160),
    operationKey: z.uuid(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.kind === "voice") !== value.mime.startsWith("audio/")) ctx.addIssue({ code: "custom", path: ["mime"], message: `is not accepted for ${value.kind} takes` });
  });
export type StartTakeInput = z.input<typeof startTakeInputSchema>;
export const takeUploadSchema = z.object({ fileId: idSchema, partBytes: z.number().int().positive(), maxParts: z.number().int().positive() });
export type TakeUpload = z.infer<typeof takeUploadSchema>;

export const takePartInputSchema = z
  .object({
    fileId: idSchema,
    partNumber: z.number().int().min(1).max(TAKE_MAX_PARTS),
    bytes: z.number().int().positive().max(TAKE_PART_BYTES),
  })
  .strict();
export type TakePartInput = z.infer<typeof takePartInputSchema>;
/** A link for exactly one part: its size is signed, so storage refuses a body of any other length. */
export const takePartUrlSchema = z.object({ url: z.string().min(1), headers: z.record(z.string(), z.string()) });
export type TakePartUrl = z.infer<typeof takePartUrlSchema>;

export const completeTakeInputSchema = z
  .object({
    fileId: idSchema,
    parts: z
      .array(z.object({ partNumber: z.number().int().min(1).max(TAKE_MAX_PARTS), etag: z.string().min(1).max(200) }).strict())
      .min(1)
      .max(TAKE_MAX_PARTS),
    bytes: z.number().int().positive(),
    /** SHA-256 of the whole take, computed by the browser over the bytes it uploaded part by part. */
    sha256: sha256Schema,
    durationSeconds: z.number().finite().positive().max(3600).nullable().default(null),
    operationKey: z.uuid(),
  })
  .strict();
export type CompleteTakeInput = z.input<typeof completeTakeInputSchema>;
export const abortTakeInputSchema = z.object({ fileId: idSchema }).strict();
export type AbortTakeInput = z.infer<typeof abortTakeInputSchema>;
