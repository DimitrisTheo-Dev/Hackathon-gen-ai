import { z } from "zod";

/**
 * Video composition contract: the edit layer the studio previews with Remotion.
 * A composition describes a 9:16 presenter-led reel (talking-head clip, captions, title cards,
 * b-roll and music) as data. Times are seconds; the player converts them to frames at its fps.
 * Standalone on purpose: it imports nothing from index.ts, so the re-export there cannot form a cycle.
 */
export const COMPOSITION_WIDTH = 1080;
export const COMPOSITION_HEIGHT = 1920;
export const MAX_COMPOSITION_SECONDS = 180;
/** Words per second used to time captions before a real transcript exists. */
export const SPEECH_RATE_WPS = 2.5;

const compositionIdSchema = z.string().min(1).max(160);
const compositionInstantSchema = z.iso.datetime({ offset: true });
/** Media the browser loads directly: HTTPS only, never credentials in the URL. */
export const mediaUrlSchema = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password;
  }, "must use https without credentials");
const secondsSchema = z.number().finite().min(0).max(MAX_COMPOSITION_SECONDS);
const volumeSchema = z.number().finite().min(0).max(1);
const clipIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "Use letters, numbers, dashes or underscores");
const timed = { id: clipIdSchema, start: secondsSchema, end: secondsSchema };

export const captionCueSchema = z.object({ ...timed, text: z.string().trim().min(1).max(140) }).strict();
export const cardSchema = z
  .object({
    ...timed,
    kind: z.enum(["title", "lower_third", "cta"]),
    title: z.string().trim().min(1).max(80),
    subtitle: z.string().trim().max(140),
  })
  .strict();
export const brollSchema = z
  .object({
    ...timed,
    media: z.enum(["video", "image"]),
    url: mediaUrlSchema,
    /** `full` covers the frame; `split` puts the b-roll on top and moves the presenter to the lower half. */
    layout: z.enum(["full", "split"]),
    trimStart: secondsSchema,
  })
  .strict();
export const presenterSchema = z
  .object({
    /** `item_media` is the item's rendered avatar video, resolved to a fresh signed URL on every read. */
    source: z.enum(["item_media", "url", "none"]),
    url: mediaUrlSchema.nullable(),
    trimStart: secondsSchema,
    volume: volumeSchema,
  })
  .strict();
export const musicSchema = z.object({ url: mediaUrlSchema, volume: volumeSchema }).strict();
export const compositionStyleSchema = z
  .object({
    accent: z.string().regex(/^#[0-9a-f]{6}$/i),
    background: z.string().regex(/^#[0-9a-f]{6}$/i),
    captionPosition: z.enum(["bottom", "center"]),
    captionSize: z.enum(["medium", "large"]),
  })
  .strict();

export const compositionSchema = z
  .object({
    version: z.literal(1),
    fps: z.union([z.literal(24), z.literal(25), z.literal(30)]),
    durationSeconds: z.number().finite().min(1).max(MAX_COMPOSITION_SECONDS),
    presenter: presenterSchema,
    captions: z.array(captionCueSchema).max(300),
    cards: z.array(cardSchema).max(20),
    broll: z.array(brollSchema).max(30),
    music: musicSchema.nullable(),
    style: compositionStyleSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    const tracks = [
      ["captions", value.captions],
      ["cards", value.cards],
      ["broll", value.broll],
    ] as const;
    for (const [track, clips] of tracks)
      clips.forEach((clip, index) => {
        if (clip.end <= clip.start) ctx.addIssue({ code: "custom", path: [track, index, "end"], message: "must be after the start" });
        if (clip.end > value.durationSeconds + 0.001) ctx.addIssue({ code: "custom", path: [track, index, "end"], message: "is past the end of the video" });
        if (seen.has(clip.id)) ctx.addIssue({ code: "custom", path: [track, index, "id"], message: "is used twice" });
        seen.add(clip.id);
      });
    if (value.presenter.source === "url" && !value.presenter.url)
      ctx.addIssue({ code: "custom", path: ["presenter", "url"], message: "is required for a linked presenter clip" });
  });
export type Composition = z.infer<typeof compositionSchema>;
export type CaptionCue = z.infer<typeof captionCueSchema>;
export type CompositionCard = z.infer<typeof cardSchema>;
export type BrollClip = z.infer<typeof brollSchema>;

/** What the studio reads: the saved composition (or a first draft derived from the item) plus resolved media. */
export const compositionDocumentSchema = z.object({
  itemId: compositionIdSchema,
  campaignId: compositionIdSchema,
  itemRevision: z.number().int().positive(),
  /** 0 means nothing has been saved yet and `composition` is a first draft built from the script. */
  revision: z.number().int().nonnegative(),
  updatedAt: compositionInstantSchema.nullable(),
  composition: compositionSchema,
  presenterMedia: z
    .object({ url: z.string().min(1), expiresAt: compositionInstantSchema, durationSeconds: z.number().nonnegative() })
    .nullable(),
});
export type CompositionDocument = z.infer<typeof compositionDocumentSchema>;
export const saveCompositionInputSchema = z
  .object({
    contentId: compositionIdSchema,
    /** The revision the editor started from; 0 for the first save. Compare-and-swap on the server. */
    expectedRevision: z.number().int().nonnegative(),
    composition: compositionSchema,
    operationKey: z.uuid(),
  })
  .strict();
export type SaveCompositionInput = z.infer<typeof saveCompositionInputSchema>;

/* ───────────────────────── first drafts ───────────────────────── */

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Splits a script into short caption pages timed across [start, end]. Pages break at sentence ends
 * and after `maxWords` words; each page's share of the time follows its word count.
 */
export function captionsFromScript(script: string, start: number, end: number, maxWords = 4): CaptionCue[] {
  const words = script.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length || end <= start) return [];
  const pages: string[][] = [];
  let page: string[] = [];
  for (const word of words) {
    page.push(word.slice(0, 60));
    if (page.length >= maxWords || /[.!?;…:]["”’)]?$/.test(word)) {
      pages.push(page);
      page = [];
    }
  }
  if (page.length) pages.push(page);
  const perWord = (end - start) / words.length;
  let cursor = start;
  return pages.slice(0, 300).map((entry, index) => {
    const from = cursor;
    cursor += entry.length * perWord;
    return { id: `cap-${index + 1}`, start: round(from), end: round(index === pages.length - 1 ? end : cursor), text: entry.join(" ").slice(0, 140) };
  });
}

/** A reasonable first composition for an item: presenter clip, title card and script captions. */
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
    version: 1,
    fps: 25,
    durationSeconds: duration,
    presenter: { source: "item_media", url: null, trimStart: 0, volume: 1 },
    captions: captionsFromScript(input.script, words ? Math.min(0.4, speechEnd / 2) : 0, speechEnd),
    cards: [{ id: "card-title", start: 0, end: Math.min(2.5, duration), kind: "title", title, subtitle: "" }],
    broll: [],
    music: null,
    style: {
      accent: /^#[0-9a-f]{6}$/i.test(input.brandColor) ? input.brandColor : "#5F6C66",
      background: "#111214",
      captionPosition: input.captionPosition,
      captionSize: "large",
    },
  });
}
