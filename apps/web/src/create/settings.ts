import type { Platform } from "@castroom/contracts";
import { defaultLanguage } from "./languages";
import { isLength, MAX_COPIES, type Draft } from "./model";

/** What a video is made for. `null` makes one vertical video for every platform. */
export const FORMATS: Array<{ id: Platform | null; label: string; detail: string }> = [
  { id: null, label: "Any", detail: "A vertical video for every platform" },
  { id: "instagram", label: "Instagram Reel", detail: "Reels and Stories" },
  { id: "tiktok", label: "TikTok", detail: "Fast hook, native captions" },
  { id: "youtube", label: "YouTube Short", detail: "Shorts feed" },
];

/**
 * Frame shapes, each with its ratio. Every composition is 1080×1920 and the render pins 9:16, so only vertical can be
 * made today; the others are listed as not available yet instead of being offered and quietly ignored.
 */
export const ASPECTS = [
  { ratio: "9:16", label: "Vertical", available: true },
  { ratio: "4:5", label: "Portrait", available: false },
  { ratio: "1:1", label: "Square", available: false },
  { ratio: "16:9", label: "Horizontal", available: false },
] as const;

/** A length as the pill shows it: "30s", "75s", then minutes from two on: "2 min", "2:30". */
export function lengthLabel(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  const rest = seconds % 60;
  return rest ? `${Math.floor(seconds / 60)}:${String(rest).padStart(2, "0")}` : `${seconds / 60} min`;
}
/** A length in a sentence: "45 seconds", "2 minutes", "2 minutes 30 seconds". */
export function lengthWords(seconds: number): string {
  if (seconds < 120) return `${seconds} seconds`;
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)} minutes${rest ? ` ${rest} seconds` : ""}`;
}

/**
 * The Describe step's settings. The home composer offers the same four, so a request typed there opens the New
 * project flow already set the way the person picked.
 */
export type VideoSettings = Pick<Draft, "seconds" | "platform" | "language" | "copies">;
/** How the New project flow is opened from elsewhere: the brief, the settings picked there, and a library format. */
export interface ProjectStart {
  brief: string;
  settings?: Partial<VideoSettings>;
  templateId?: string;
}

export const defaultSettings = (): VideoSettings => ({ seconds: 30, platform: null, language: defaultLanguage(), copies: [] });

/**
 * Settings picked elsewhere, applied to a draft and kept valid: a length the flow offers, no copy in the main
 * language, at most `MAX_COPIES` copies. Anything not picked keeps the draft's own value.
 */
export function withSettings(draft: Draft, settings: Partial<VideoSettings> = {}, templateId?: string): Draft {
  const language = settings.language ?? draft.language;
  const seconds = isLength(settings.seconds) ? settings.seconds : draft.seconds;
  const copies = [...new Set(settings.copies ?? draft.copies)].filter((code) => code !== language).slice(0, MAX_COPIES);
  return {
    ...draft,
    seconds,
    platform: settings.platform !== undefined ? settings.platform : draft.platform,
    language,
    copies,
    templateId: templateId ?? draft.templateId,
  };
}
