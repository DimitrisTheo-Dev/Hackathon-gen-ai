import {
  MAX_COMPOSITION_SECONDS,
  NO_TRANSITION,
  captionsFromScript,
  captionsFromWords,
  compositionSchema,
  type AudioClip,
  type CaptionCue,
  type ClipSource,
  type Composition,
  type CompositionCard,
  type TranscriptWord,
  type VideoClip,
} from "@castroom/contracts";

/** Pure editing helpers for the video studio. Every function returns a new composition. */
export type Track = "video" | "audio" | "cards" | "captions";
export type Clip = VideoClip | AudioClip | CompositionCard | CaptionCue;
export const TRACKS: Track[] = ["video", "audio", "cards", "captions"];

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

const allClips = (composition: Composition): Clip[] => [...composition.video, ...composition.audio, ...composition.cards, ...composition.captions];

/** The first `<prefix>-N` id not used by any clip on any track. */
export function nextClipId(composition: Composition, prefix: string) {
  const used = new Set(allClips(composition).map((clip) => clip.id));
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
  const span = Math.min(length, end);
  const start = round(Math.min(Math.max(0, at), Math.max(0, end - span)));
  return { start, end: round(Math.min(end, start + span)) };
}

export function addCaption(composition: Composition, at: number, text = "New caption"): Composition {
  const clip: CaptionCue = { id: nextClipId(composition, "cap"), ...windowAt(composition, at, 2), text };
  return { ...composition, captions: sorted([...composition.captions, clip]) };
}

const CARD_DEFAULTS: Record<CompositionCard["kind"], { title: string; subtitle: string; length: number }> = {
  title: { title: "Title", subtitle: "", length: 2.5 },
  lower_third: { title: "Name Surname", subtitle: "Role or credential", length: 4 },
  cta: { title: "Book a visit", subtitle: "Link in bio", length: 3 },
  statement: { title: "One clear point", subtitle: "", length: 3.5 },
};
export function addCard(composition: Composition, kind: CompositionCard["kind"], at: number, imageFileId: string | null = null): Composition {
  const preset = CARD_DEFAULTS[kind];
  const clip: CompositionCard = { id: nextClipId(composition, "card"), ...windowAt(composition, at, preset.length), kind, title: preset.title, subtitle: preset.subtitle, imageFileId };
  return { ...composition, cards: sorted([...composition.cards, clip]) };
}

/** A clip from a draft file or link. Main-layer clips keep their sound; overlays start muted. */
export function addVideoClip(composition: Composition, input: { source: ClipSource; media: VideoClip["media"]; at: number; length: number; layer: 0 | 1 }): Composition {
  const clip: VideoClip = {
    id: nextClipId(composition, input.layer === 0 ? "shot" : "broll"),
    ...windowAt(composition, input.at, input.length),
    source: input.source,
    media: input.media,
    in: 0,
    layer: input.layer,
    layout: input.layer === 0 ? "full" : "split",
    volume: input.layer === 0 && input.media === "video" ? 1 : 0,
    syncOffsetFrames: 0,
    transitionIn: input.layer === 0 ? NO_TRANSITION : { kind: "fade", duration: 0.25 },
    transitionOut: input.layer === 0 ? NO_TRANSITION : { kind: "fade", duration: 0.2 },
  };
  return { ...composition, video: sorted([...composition.video, clip]) };
}

const AUDIO_DEFAULTS: Record<AudioClip["role"], Pick<AudioClip, "volume" | "fadeIn" | "fadeOut" | "loop">> = {
  voice: { volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
  music: { volume: 0.18, fadeIn: 1, fadeOut: 1.5, loop: true },
  sfx: { volume: 0.6, fadeIn: 0, fadeOut: 0, loop: false },
};
/** Voice and music span from the playhead to the end (or their own length); SFX are short. */
export function addAudioClip(composition: Composition, input: { source: ClipSource; role: AudioClip["role"]; at: number; length: number }): Composition {
  const clip: AudioClip = { id: nextClipId(composition, input.role), ...windowAt(composition, input.at, input.length), source: input.source, in: 0, role: input.role, ...AUDIO_DEFAULTS[input.role] };
  return { ...composition, audio: sorted([...composition.audio, clip]) };
}

export function updateClip(composition: Composition, track: Track, id: string, patch: Partial<Clip>): Composition {
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
  const transcript = composition.transcript && {
    ...composition.transcript,
    words: composition.transcript.words.filter((word) => word.start < durationSeconds).map((word) => (word.end > durationSeconds ? { ...word, end: durationSeconds } : word)),
  };
  return { ...composition, durationSeconds, video: fit(composition.video), audio: fit(composition.audio), cards: fit(composition.cards), captions: fit(composition.captions), transcript };
}

/** Rebuilds captions from the script across the span the current captions cover (or the whole video). */
export function captionsFromItemScript(composition: Composition, script: string): Composition {
  const start = composition.captions[0]?.start ?? Math.min(0.4, composition.durationSeconds / 2);
  const end = composition.captions.at(-1)?.end ?? composition.durationSeconds;
  return { ...composition, captions: captionsFromScript(script, start, end > start ? end : composition.durationSeconds) };
}

/** Rebuilds captions from the word-level transcript, skipping time covered by full-screen statement cards. */
export function captionsFromTranscript(composition: Composition, maxWords = 4): Composition {
  const words = composition.transcript?.words ?? [];
  const statements = composition.cards.filter((card) => card.kind === "statement");
  const visible = words.filter((word) => word.end <= composition.durationSeconds && !statements.some((card) => word.start >= card.start && word.start < card.end));
  return { ...composition, captions: captionsFromWords(visible, maxWords).map((cue) => ({ ...cue, end: Math.min(cue.end, composition.durationSeconds) })) };
}

/**
 * Reads a word-timing file into transcript words. Accepts `[{t|text|word, s|start, e|end}]`, the shapes
 * MAI-Transcribe, Whisper-style tools and the reel scripts write, optionally under a `words` key.
 */
export function parseWords(text: string): TranscriptWord[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The transcript file is not valid JSON.");
  }
  const list = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { words?: unknown }).words) ? (data as { words: unknown[] }).words : null;
  if (!list) throw new Error("The transcript file has no list of words.");
  const words: TranscriptWord[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const t = String(row.t ?? row.text ?? row.word ?? "").trim();
    const start = Number(row.s ?? row.start);
    const end = Number(row.e ?? row.end);
    if (t && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start) words.push({ t: t.slice(0, 60), start: round(start), end: round(end) });
  }
  if (!words.length) throw new Error("No timed words were found in the transcript file.");
  return words.slice(0, 3000);
}

/** Moves every transcript word by `seconds` (for a voice clip that starts later on the timeline). */
export function shiftTranscript(composition: Composition, seconds: number): Composition {
  if (!composition.transcript) return composition;
  return {
    ...composition,
    transcript: {
      ...composition.transcript,
      words: composition.transcript.words
        .map((word) => ({ ...word, start: round(word.start + seconds), end: round(word.end + seconds) }))
        .filter((word) => word.start >= 0 && word.start < MAX_COMPOSITION_SECONDS),
    },
  };
}

export function activeAt<T extends Clip>(clips: T[], seconds: number) {
  return clips.filter((clip) => seconds >= clip.start && seconds < clip.end);
}

export interface Issue {
  track: Track | "transcript" | "other";
  index: number | null;
  message: string;
}
const TRACK_NAMES: Record<string, string> = { video: "Video clip", audio: "Audio clip", cards: "Card", captions: "Caption" };
const FIELD_NAMES: Record<string, string> = { end: "end", start: "start", text: "text", title: "title", subtitle: "subtitle", url: "link", id: "id", in: "in-point", source: "source", volume: "volume" };

/** Contract problems, worded for people. An empty list means the server will accept the edit. */
export function issues(composition: Composition): Issue[] {
  const result = compositionSchema.safeParse(composition);
  if (result.success) return [];
  return result.error.issues.slice(0, 12).map((issue) => {
    const [track, index, field, sub] = issue.path as Array<string | number>;
    const name = sub === "url" ? "url" : String(field);
    const problem =
      issue.code === "custom"
        ? issue.message
        : issue.code === "too_small"
          ? issue.origin === "string" ? "is empty" : "cannot be negative"
          : issue.code === "too_big"
            ? issue.origin === "string" ? "is too long" : "is too large"
            : name === "url" ? "must be an https link" : "is not valid";
    if (track in TRACK_NAMES && typeof index === "number") return { track: track as Track, index, message: `${TRACK_NAMES[track]} ${index + 1}: ${FIELD_NAMES[name] ?? "value"} ${problem}` };
    if (track === "transcript") return { track: "transcript", index: null, message: `Transcript word ${typeof field === "number" ? field + 1 : ""} ${problem}`.replace(/\s+/g, " ") };
    if (track === "labels") return { track: "other", index: null, message: `Disclaimer ${problem}` };
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
