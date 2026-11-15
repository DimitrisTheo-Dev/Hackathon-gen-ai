import { z } from "zod";

/**
 * Reel production contract: draft files and the multi-track timeline the studio, agents and render
 * workers share. A 9:16 presenter-led short is data: video clips on two layers (main picture and
 * overlays), audio clips by role (voice, music, sfx), cards, captions and a word-level transcript.
 * Times are seconds on the timeline; `in` is where a clip starts inside its source file.
 * Standalone on purpose: it imports nothing from index.ts, so the re-export there cannot form a cycle.
 */
export const COMPOSITION_WIDTH = 1080;
export const COMPOSITION_HEIGHT = 1920;
export const MAX_COMPOSITION_SECONDS = 180;
/** Words per second used to time captions before a real transcript exists. */
export const SPEECH_RATE_WPS = 2.5;

const idSchema = z.string().min(1).max(160);
const instantSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase hex SHA-256");
/** Media a browser or worker loads directly: HTTPS only, never credentials in the URL. */
export const mediaUrlSchema = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password;
  }, "must use https without credentials");
const secondsSchema = z.number().finite().min(0).max(MAX_COMPOSITION_SECONDS);
const sourceSecondsSchema = z.number().finite().min(0).max(3600);
const volumeSchema = z.number().finite().min(0).max(1);
const clipIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "Use letters, numbers, dashes or underscores");

/* ───────────────────────── draft files ───────────────────────── */

export const FILE_KINDS = ["script", "facts", "voice", "transcript", "avatar_clip", "video", "image", "music", "sfx", "captions", "cut_list", "render", "other"] as const;
export const fileKindSchema = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof fileKindSchema>;
const AUDIO = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/aac", "audio/ogg", "audio/webm", "audio/flac"];
const VIDEO = ["video/mp4", "video/webm", "video/quicktime"];
const IMAGE = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const TEXT_MIMES = ["text/markdown", "text/plain", "application/json", "text/vtt", "application/x-subrip"] as const;
/** What each kind of draft may contain. SVG and HTML are never accepted: they can carry script. */
export const FILE_MIMES: Record<FileKind, string[]> = {
  script: [...TEXT_MIMES],
  facts: [...TEXT_MIMES],
  transcript: [...TEXT_MIMES],
  captions: [...TEXT_MIMES],
  cut_list: [...TEXT_MIMES],
  voice: AUDIO,
  music: AUDIO,
  sfx: AUDIO,
  avatar_clip: VIDEO,
  video: VIDEO,
  render: VIDEO,
  image: IMAGE,
  other: [...TEXT_MIMES, ...AUDIO, ...VIDEO, ...IMAGE],
};
const MB = 1024 * 1024;
export function maxFileBytes(mime: string) {
  if (VIDEO.includes(mime)) return 1024 * MB;
  if (AUDIO.includes(mime)) return 200 * MB;
  if (IMAGE.includes(mime)) return 25 * MB;
  return 5 * MB;
}
export const isTextMime = (mime: string) => (TEXT_MIMES as readonly string[]).includes(mime);
export const isImageMime = (mime: string) => IMAGE.includes(mime);
export const isVideoMime = (mime: string) => VIDEO.includes(mime);
export const isAudioMime = (mime: string) => AUDIO.includes(mime);

const metaSchema = z
  .record(z.string().max(60), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 30, "has too many entries");
export const draftFileSchema = z.object({
  id: idSchema,
  campaignId: idSchema,
  itemId: idSchema.nullable(),
  kind: fileKindSchema,
  name: z.string().min(1).max(160),
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: sha256Schema,
  durationSeconds: z.number().nonnegative().nullable(),
  /** Provenance such as provider, model, voice or prompt. Plain values only. */
  meta: metaSchema,
  state: z.enum(["pending", "ready", "archived"]),
  /** Counts uploads under the same name in the same item: 1, 2, 3… */
  version: z.number().int().positive(),
  createdBy: z.string(),
  createdAt: instantSchema,
  /** Short-lived link for ready files; null otherwise. */
  url: z.string().nullable(),
  urlExpiresAt: instantSchema.nullable(),
});
export type DraftFile = z.infer<typeof draftFileSchema>;

const fileFields = {
  campaignId: idSchema,
  itemId: idSchema.nullable().default(null),
  kind: fileKindSchema,
  name: z.string().trim().min(1).max(160),
  durationSeconds: z.number().finite().nonnegative().max(3600).nullable().default(null),
  meta: metaSchema.default({}),
  operationKey: z.uuid(),
};
export const requestUploadInputSchema = z
  .object({ ...fileFields, mime: z.string().min(3).max(100), bytes: z.number().int().positive(), sha256: sha256Schema })
  .strict()
  .superRefine((value, ctx) => {
    if (!FILE_MIMES[value.kind].includes(value.mime)) ctx.addIssue({ code: "custom", path: ["mime"], message: `is not accepted for ${value.kind} files` });
    if (value.bytes > maxFileBytes(value.mime)) ctx.addIssue({ code: "custom", path: ["bytes"], message: "is over the size limit for this type" });
  });
export type RequestUploadInput = z.input<typeof requestUploadInputSchema>;
export const uploadTicketSchema = z.object({
  file: draftFileSchema,
  /** Null when identical bytes are already stored: the file is ready without uploading again. */
  upload: z.object({ url: z.string().min(1), method: z.literal("PUT"), headers: z.record(z.string(), z.string()), expiresAt: instantSchema }).nullable(),
});
export type UploadTicket = z.infer<typeof uploadTicketSchema>;
export const completeUploadInputSchema = z.object({ fileId: idSchema, operationKey: z.uuid() }).strict();
export const saveTextFileInputSchema = z
  .object({ ...fileFields, mime: z.enum(TEXT_MIMES), text: z.string().min(1).max(200_000) })
  .strict()
  .superRefine((value, ctx) => {
    if (!FILE_MIMES[value.kind].includes(value.mime)) ctx.addIssue({ code: "custom", path: ["mime"], message: `is not accepted for ${value.kind} files` });
  });
export type SaveTextFileInput = z.input<typeof saveTextFileInputSchema>;
export const archiveFileInputSchema = z.object({ fileId: idSchema, operationKey: z.uuid() }).strict();

/* ───────────────────────── timeline ───────────────────────── */

export const clipSourceSchema = z.discriminatedUnion("kind", [
  /** A draft file in the same project. */
  z.object({ kind: z.literal("file"), fileId: idSchema }).strict(),
  /** The item's rendered avatar video, resolved to a fresh signed URL on every read. */
  z.object({ kind: z.literal("item_media") }).strict(),
  /** An https link loaded by each viewer's browser and by the render worker. */
  z.object({ kind: z.literal("url"), url: mediaUrlSchema }).strict(),
]);
export type ClipSource = z.infer<typeof clipSourceSchema>;
export const transitionSchema = z.object({ kind: z.enum(["cut", "fade", "slide_up", "zoom"]), duration: z.number().finite().min(0).max(2) }).strict();
export type Transition = z.infer<typeof transitionSchema>;
const timed = { id: clipIdSchema, start: secondsSchema, end: secondsSchema };

export const videoClipSchema = z
  .object({
    ...timed,
    source: clipSourceSchema,
    media: z.enum(["video", "image"]),
    /** Where the clip starts inside its source, in seconds. */
    in: sourceSecondsSchema,
    /** 0 is the main picture (usually the presenter); 1 sits on top (b-roll, graphics). */
    layer: z.union([z.literal(0), z.literal(1)]),
    /** `split` puts an overlay on the upper half and moves the main picture down; `window` is a rounded inset. */
    layout: z.enum(["full", "split", "window"]),
    volume: volumeSchema,
    /** Delays the picture against its own audio, for lip-sync correction (positive = later). */
    syncOffsetFrames: z.number().int().min(-12).max(12),
    transitionIn: transitionSchema,
    transitionOut: transitionSchema,
  })
  .strict();
export const audioClipSchema = z
  .object({
    ...timed,
    source: clipSourceSchema,
    in: sourceSecondsSchema,
    role: z.enum(["voice", "music", "sfx"]),
    volume: volumeSchema,
    fadeIn: z.number().finite().min(0).max(10),
    fadeOut: z.number().finite().min(0).max(10),
    loop: z.boolean(),
  })
  .strict();
export const captionCueSchema = z.object({ ...timed, text: z.string().trim().min(1).max(140) }).strict();
export const cardSchema = z
  .object({
    ...timed,
    /** `statement` is one full-screen graphic: big text, optional image, no captions over it. */
    kind: z.enum(["title", "lower_third", "cta", "statement"]),
    title: z.string().trim().min(1).max(80),
    subtitle: z.string().trim().max(140),
    imageFileId: idSchema.nullable(),
  })
  .strict();
export const transcriptWordSchema = z.object({ t: z.string().min(1).max(60), start: secondsSchema, end: secondsSchema }).strict();
export const transcriptSchema = z
  .object({ language: z.string().min(2).max(12), words: z.array(transcriptWordSchema).max(3000), sourceFileId: idSchema.nullable() })
  .strict();
export const compositionStyleSchema = z
  .object({
    accent: z.string().regex(/^#[0-9a-f]{6}$/i),
    background: z.string().regex(/^#[0-9a-f]{6}$/i),
    captionPosition: z.enum(["bottom", "center"]),
    captionSize: z.enum(["medium", "large"]),
    /** Lowers music while a voice clip plays. */
    duckMusic: z.boolean(),
  })
  .strict();
/** On-screen honesty labels. An avatar presenter is labelled by default; a disclaimer line is optional. */
export const labelsSchema = z.object({ aiAvatar: z.boolean(), disclaimer: z.string().trim().max(160) }).strict();

export const compositionSchema = z
  .object({
    version: z.literal(2),
    fps: z.union([z.literal(24), z.literal(25), z.literal(30)]),
    durationSeconds: z.number().finite().min(1).max(MAX_COMPOSITION_SECONDS),
    video: z.array(videoClipSchema).max(80),
    audio: z.array(audioClipSchema).max(80),
    cards: z.array(cardSchema).max(30),
    captions: z.array(captionCueSchema).max(400),
    transcript: transcriptSchema.nullable(),
    style: compositionStyleSchema,
    labels: labelsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    const tracks = [
      ["video", value.video],
      ["audio", value.audio],
      ["cards", value.cards],
      ["captions", value.captions],
    ] as const;
    for (const [track, clips] of tracks)
      clips.forEach((clip, index) => {
        if (clip.end <= clip.start) ctx.addIssue({ code: "custom", path: [track, index, "end"], message: "must be after the start" });
        if (clip.end > value.durationSeconds + 0.001) ctx.addIssue({ code: "custom", path: [track, index, "end"], message: "is past the end of the video" });
        if (seen.has(clip.id)) ctx.addIssue({ code: "custom", path: [track, index, "id"], message: "is used twice" });
        seen.add(clip.id);
      });
    value.transcript?.words.forEach((word, index) => {
      if (word.end < word.start) ctx.addIssue({ code: "custom", path: ["transcript", "words", index, "end"], message: "must not be before the start" });
    });
  });
export type Composition = z.infer<typeof compositionSchema>;
export type VideoClip = z.infer<typeof videoClipSchema>;
export type AudioClip = z.infer<typeof audioClipSchema>;
export type CaptionCue = z.infer<typeof captionCueSchema>;
export type CompositionCard = z.infer<typeof cardSchema>;
export type TranscriptWord = z.infer<typeof transcriptWordSchema>;

/** Every draft file a composition points at. */
export function referencedFileIds(composition: Composition) {
  const ids = new Set<string>();
  for (const clip of [...composition.video, ...composition.audio]) if (clip.source.kind === "file") ids.add(clip.source.fileId);
  for (const card of composition.cards) if (card.imageFileId) ids.add(card.imageFileId);
  if (composition.transcript?.sourceFileId) ids.add(composition.transcript.sourceFileId);
  return [...ids];
}

/** A playable link for a clip source, as the studio and render workers receive it. */
export const resolvedMediaSchema = z.object({ url: z.string().min(1), mime: z.string(), expiresAt: instantSchema, durationSeconds: z.number().nonnegative().nullable(), name: z.string() });
export type ResolvedMedia = z.infer<typeof resolvedMediaSchema>;

/** What the studio reads: the saved timeline (or a first draft from the item) plus resolved media links. */
export const compositionDocumentSchema = z.object({
  itemId: idSchema,
  campaignId: idSchema,
  itemRevision: z.number().int().positive(),
  /** 0 means nothing has been saved yet and `composition` is a first draft built from the script. */
  revision: z.number().int().nonnegative(),
  updatedAt: instantSchema.nullable(),
  composition: compositionSchema,
  /** The item's rendered avatar video, when there is one. */
  itemMedia: resolvedMediaSchema.nullable(),
  /** Draft files the timeline uses, by file id. Missing ids were archived or never finished uploading. */
  files: z.record(z.string(), resolvedMediaSchema),
});
export type CompositionDocument = z.infer<typeof compositionDocumentSchema>;
export const saveCompositionInputSchema = z
  .object({
    contentId: idSchema,
    /** The revision the editor started from; 0 for the first save. Compare-and-swap on the server. */
    expectedRevision: z.number().int().nonnegative(),
    composition: compositionSchema,
    operationKey: z.uuid(),
  })
  .strict();
export type SaveCompositionInput = z.infer<typeof saveCompositionInputSchema>;

/* ───────────────────────── renders ───────────────────────── */

export const reelRenderSchema = z.object({
  id: idSchema,
  itemId: idSchema,
  compositionRevision: z.number().int().positive(),
  state: z.enum(["queued", "rendering", "succeeded", "failed", "cancelled"]),
  progress: z.number().min(0).max(1),
  workerId: z.string().nullable(),
  error: z.string().nullable(),
  outputFile: draftFileSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type ReelRender = z.infer<typeof reelRenderSchema>;
export const queueRenderInputSchema = z
  .object({ contentId: idSchema, expectedRevision: z.number().int().positive(), operationKey: z.uuid() })
  .strict();
export type QueueRenderInput = z.infer<typeof queueRenderInputSchema>;

/* ───────────────────────── first drafts ───────────────────────── */

const round = (value: number) => Math.round(value * 100) / 100;
export const NO_TRANSITION: Transition = { kind: "cut", duration: 0 };

/** Caption pages from timed words: break at sentence ends, after `maxWords`, or at a pause over 0.6 s. */
export function captionsFromWords(words: TranscriptWord[], maxWords = 4, lastEnd?: number): CaptionCue[] {
  const pages: TranscriptWord[][] = [];
  let page: TranscriptWord[] = [];
  words.forEach((word, index) => {
    page.push(word);
    const next = words[index + 1];
    if (page.length >= maxWords || /[.!?;…:;]["”’»)]?$/.test(word.t) || (next && next.start - word.end > 0.6)) {
      pages.push(page);
      page = [];
    }
  });
  if (page.length) pages.push(page);
  return pages.slice(0, 400).map((entry, index) => {
    const next = pages[index + 1];
    const last = entry[entry.length - 1];
    // A page holds until the next one starts (short gaps only), so captions do not flicker between words.
    const end = next && next[0].start - last.end < 0.6 ? next[0].start : !next && lastEnd !== undefined ? lastEnd : last.end;
    return { id: `cap-${index + 1}`, start: round(entry[0].start), end: round(Math.max(end, entry[0].start + 0.04)), text: entry.map((word) => word.t).join(" ").slice(0, 140) };
  });
}

/**
 * Splits a script into short caption pages timed across [start, end]. Pages break at sentence ends
 * and after `maxWords` words; each page's share of the time follows its word count.
 */
export function captionsFromScript(script: string, start: number, end: number, maxWords = 4): CaptionCue[] {
  const words = script.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length || end <= start) return [];
  const perWord = (end - start) / words.length;
  return captionsFromWords(
    words.map((t, index) => ({ t: t.slice(0, 60), start: round(start + index * perWord), end: round(start + (index + 1) * perWord) })),
    maxWords,
    end,
  );
}

/** A reasonable first timeline for an item: presenter clip, title card and script captions. */
export function draftComposition(input: {
  title: string;
  script: string;
  brandColor: string;
  captionPosition: "bottom" | "center";
  mediaDurationSeconds: number | null;
}): Composition {
  const words = input.script.trim().split(/\s+/).filter(Boolean).length;
  const spoken = words / SPEECH_RATE_WPS;
  const media = input.mediaDurationSeconds && input.mediaDurationSeconds >= 1 ? input.mediaDurationSeconds : null;
  const duration = round(Math.min(MAX_COMPOSITION_SECONDS, Math.max(5, media ?? Math.ceil(spoken + 1.5))));
  const speechEnd = media ? duration : Math.min(duration, round(0.4 + spoken));
  const title = input.title.trim().slice(0, 80) || "Untitled";
  return compositionSchema.parse({
    version: 2,
    fps: 25,
    durationSeconds: duration,
    video: [
      { id: "presenter", start: 0, end: duration, source: { kind: "item_media" }, media: "video", in: 0, layer: 0, layout: "full", volume: 1, syncOffsetFrames: 0, transitionIn: NO_TRANSITION, transitionOut: NO_TRANSITION },
    ],
    audio: [],
    cards: [{ id: "card-title", start: 0, end: Math.min(2.5, duration), kind: "title", title, subtitle: "", imageFileId: null }],
    captions: captionsFromScript(input.script, words ? Math.min(0.4, speechEnd / 2) : 0, speechEnd),
    transcript: null,
    style: {
      accent: /^#[0-9a-f]{6}$/i.test(input.brandColor) ? input.brandColor : "#5F6C66",
      background: "#111214",
      captionPosition: input.captionPosition,
      captionSize: "large",
      duckMusic: true,
    },
    labels: { aiAvatar: true, disclaimer: "" },
  });
}
