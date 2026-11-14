import {
  MAX_COMPOSITION_SECONDS,
  captionsFromScript,
  compositionSchema,
  type BrollClip,
  type CaptionCue,
  type Composition,
  type CompositionCard,
} from "@castroom/contracts";

/** Pure editing helpers for the video studio. Every function returns a new composition. */
export type Track = "captions" | "cards" | "broll";
export type Clip = CaptionCue | CompositionCard | BrollClip;
type TrackClip<T extends Track> = Composition[T][number];

export const round = (value: number) => Math.round(value * 100) / 100;
export const toFrames = (seconds: number, fps: number) => Math.round(seconds * fps);
export const durationInFrames = (composition: Composition) => Math.max(1, toFrames(composition.durationSeconds, composition.fps));

/** `12.5` → `0:12.5`; used for labels and the timeline. */
export function timeLabel(seconds: number) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = round(safe - minutes * 60);
  return `${minutes}:${rest < 10 ? "0" : ""}${rest.toFixed(1).replace(/\.0$/, "")}`;
}

/** The first `<prefix>-N` id not used by any clip on any track. */
export function nextClipId(composition: Composition, prefix: string) {
  const used = new Set([...composition.captions, ...composition.cards, ...composition.broll].map((clip) => clip.id));
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

function sorted<T extends Clip>(clips: T[]) {
  return [...clips].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** A window of `length` seconds starting at `at`, kept inside the video. */
export function windowAt(composition: Composition, at: number, length: number) {
  const end = composition.durationSeconds;
  const start = round(Math.min(Math.max(0, at), Math.max(0, end - Math.min(length, end))));
  return { start, end: round(Math.min(end, start + length)) };
}

export function addCaption(composition: Composition, at: number, text = "New caption"): Composition {
  const clip: CaptionCue = { id: nextClipId(composition, "cap"), ...windowAt(composition, at, 2), text };
  return { ...composition, captions: sorted([...composition.captions, clip]) };
}

const CARD_DEFAULTS: Record<CompositionCard["kind"], { title: string; subtitle: string; length: number }> = {
  title: { title: "Title", subtitle: "", length: 2.5 },
  lower_third: { title: "Name Surname", subtitle: "Role or credential", length: 4 },
  cta: { title: "Book a visit", subtitle: "Link in bio", length: 3 },
};
export function addCard(composition: Composition, kind: CompositionCard["kind"], at: number): Composition {
  const preset = CARD_DEFAULTS[kind];
  const clip: CompositionCard = { id: nextClipId(composition, "card"), ...windowAt(composition, at, preset.length), kind, title: preset.title, subtitle: preset.subtitle };
  return { ...composition, cards: sorted([...composition.cards, clip]) };
}

export function addBroll(composition: Composition, at: number, url: string, media: BrollClip["media"]): Composition {
  const clip: BrollClip = { id: nextClipId(composition, "broll"), ...windowAt(composition, at, 3), media, url, layout: "split", trimStart: 0 };
  return { ...composition, broll: sorted([...composition.broll, clip]) };
}

export function updateClip<T extends Track>(composition: Composition, track: T, id: string, patch: Partial<TrackClip<T>>): Composition {
  // Never re-sorts: a row must not move while someone is typing in it. Call `sortTrack` when they leave the field.
  return { ...composition, [track]: (composition[track] as Clip[]).map((clip) => (clip.id === id ? { ...clip, ...patch } : clip)) };
}

export function sortTrack(composition: Composition, track: Track): Composition {
  return { ...composition, [track]: sorted(composition[track] as Clip[]) };
}

export function removeClip(composition: Composition, track: Track, id: string): Composition {
  return { ...composition, [track]: (composition[track] as Clip[]).filter((clip) => clip.id !== id) };
}

/** Changes the length; clips that start after the new end are dropped and the rest are trimmed to fit. */
export function setDuration(composition: Composition, seconds: number): Composition {
  const durationSeconds = round(Math.min(MAX_COMPOSITION_SECONDS, Math.max(1, seconds)));
  const fit = <T extends Clip>(clips: T[]) =>
    clips.filter((clip) => clip.start < durationSeconds - 0.05).map((clip) => (clip.end > durationSeconds ? { ...clip, end: durationSeconds } : clip));
  return { ...composition, durationSeconds, captions: fit(composition.captions), cards: fit(composition.cards), broll: fit(composition.broll) };
}

/** Rebuilds captions from the script across the span the current captions cover (or the whole video). */
export function captionsFromItemScript(composition: Composition, script: string): Composition {
  const start = composition.captions[0]?.start ?? Math.min(0.4, composition.durationSeconds / 2);
  const end = composition.captions.at(-1)?.end ?? composition.durationSeconds;
  return { ...composition, captions: captionsFromScript(script, start, end > start ? end : composition.durationSeconds) };
}

export function activeAt<T extends Clip>(clips: T[], seconds: number) {
  return clips.filter((clip) => seconds >= clip.start && seconds < clip.end);
}

export interface Issue {
  track: Track | "presenter" | "music" | "other";
  index: number | null;
  message: string;
}
const TRACK_NAMES: Record<string, string> = { captions: "Caption", cards: "Card", broll: "B-roll clip" };
const FIELD_NAMES: Record<string, string> = { end: "end", start: "start", text: "text", title: "title", subtitle: "subtitle", url: "link", id: "id", trimStart: "trim" };

/** Contract problems, worded for people. An empty list means the server will accept the edit. */
export function issues(composition: Composition): Issue[] {
  const result = compositionSchema.safeParse(composition);
  if (result.success) return [];
  return result.error.issues.slice(0, 12).map((issue) => {
    const [track, index, field] = issue.path as Array<string | number>;
    const problem =
      issue.code === "custom"
        ? issue.message
        : issue.code === "too_small"
          ? issue.origin === "string" ? "is empty" : "cannot be negative"
          : issue.code === "too_big"
            ? issue.origin === "string" ? "is too long" : "is past the 3 minute limit"
            : field === "url" ? "must be an https link" : "is not valid";
    if (track in TRACK_NAMES && typeof index === "number")
      return { track: track as Track, index, message: `${TRACK_NAMES[track]} ${index + 1}: ${FIELD_NAMES[String(field)] ?? "value"} ${problem}` };
    if (track === "presenter") return { track: "presenter", index: null, message: `Presenter link ${field === "url" && issue.code !== "custom" ? "must be an https link" : problem}` };
    if (track === "music") return { track: "music", index: null, message: "Music needs an https link." };
    return { track: "other", index: null, message: issue.message };
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const sameComposition = (a: Composition, b: Composition) => canonical(a) === canonical(b);
