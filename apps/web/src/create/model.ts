import {
  captionsFromWords,
  MAX_COMPOSITION_SECONDS,
  compositionSchema,
  draftComposition,
  scriptFromBeats,
  SPEECH_RATE_WPS,
  type Composition,
  type LibraryTemplate,
  type Platform,
  type PresenterMode,
  type ScriptBeat,
  type TranscriptWord,
} from "@castroom/contracts";
import { defaultLanguage } from "./languages";

/**
 * The guided New project flow, as plain data: which steps apply, what the person has chosen so far (kept in this
 * browser so closing the flow loses nothing), and the rough preview built from those choices before any render.
 */
export type StepId = "describe" | "look" | "make" | "script" | "record" | "preview";
export const STEP_LABELS: Record<StepId, string> = { describe: "Describe", look: "Look", make: "Make", script: "Script", record: "Record", preview: "Preview" };
/** Target lengths, in seconds. A target, not a promise: the script decides the final length. */
export const LENGTHS = [15, 30, 45, 60, 90] as const;
/**
 * A custom length is any whole number of seconds in this range. Script drafting and rendering both stop at
 * `MAX_COMPOSITION_SECONDS` (three minutes), so a longer video cannot be made yet.
 */
export const MIN_SECONDS = 5;
export const MAX_SECONDS = MAX_COMPOSITION_SECONDS;
export type Seconds = number;
export const isLength = (value: unknown): value is Seconds => Number.isInteger(value) && (value as number) >= MIN_SECONDS && (value as number) <= MAX_SECONDS;
/** A language code from languages.ts (en, el, pt-BR…). */
export type Language = string;
/** At most this many extra language versions, so the project stays within three videos. */
export const MAX_COPIES = 2;

export interface Presenter {
  mode: PresenterMode;
  personaId: string | null;
  avatarId: string | null;
}
/** Who appears on screen: a persona in one of its looks (null = its scan photo), a stock avatar, or no face. */
export type Face = { kind: "persona"; personaId: string; lookId: string | null } | { kind: "avatar"; avatarId: string } | { kind: "none" };
/** Who makes it: the AI (avatar or captions), or the person recording themself on camera or voice only. */
export type Making = "ai" | "camera" | "voice";
/** A finished recording. `localUrl` plays the bytes still in this tab; it is never stored. */
export interface Take {
  fileId: string;
  kind: "voice" | "avatar_clip";
  mime: string;
  durationSeconds: number;
  words: TranscriptWord[] | null;
  localUrl: string | null;
}
export interface Draft {
  version: 1;
  brief: string;
  seconds: Seconds;
  platform: Platform | null;
  language: Language;
  /** Extra languages: each becomes its own translated draft in the project. */
  copies: Language[];
  /** A library template, or null for a plain presenter video. */
  templateId: string | null;
  accent: string;
  face: Face | null;
  making: Making;
  title: string;
  beats: ScriptBeat[] | null;
  /** The inputs the current script was drafted from; a different key means the script may be out of date. */
  scriptKey: string | null;
  /** The person changed the script by hand, so it is never replaced without asking. */
  edited: boolean;
  /** The saved project, once the script step is passed. */
  project: { campaignId: string; itemId: string; revision: number; saved: string; copies?: Language[] } | null;
  take: Take | null;
}

export function emptyDraft(brandColor: string, brief = ""): Draft {
  return {
    version: 1,
    brief,
    seconds: 30,
    platform: null,
    language: defaultLanguage(),
    copies: [],
    templateId: null,
    accent: /^#[0-9a-f]{6}$/i.test(brandColor) ? brandColor : "#2A2A27",
    face: null,
    making: "ai",
    title: "",
    beats: null,
    scriptKey: null,
    edited: false,
    project: null,
    take: null,
  };
}

/** The presenter the rest of the studio understands, from the face and who makes it. */
export function presenterOf(draft: Pick<Draft, "face" | "making">): Presenter | null {
  const none = { personaId: null, avatarId: null };
  if (draft.making === "camera") return { mode: "camera", ...none };
  if (draft.making === "voice") return { mode: "voice", ...none };
  if (!draft.face) return null;
  if (draft.face.kind === "persona") return { mode: "persona", personaId: draft.face.personaId, avatarId: null };
  if (draft.face.kind === "avatar") return { mode: "avatar", personaId: null, avatarId: draft.face.avatarId };
  return { mode: "none", ...none };
}
export const records = (presenter: Presenter | null) => presenter?.mode === "voice" || presenter?.mode === "camera";
export function stepsFor(presenter: Presenter | null): StepId[] {
  return ["describe", "look", "make", "script", ...(records(presenter) ? (["record"] as const) : []), "preview"];
}
/** Who speaks, as far as the words go: an AI presenter (persona or stock avatar), the person themself (camera or voice), or no one. */
const speakerOf = (mode: PresenterMode | undefined) => (mode === "camera" || mode === "voice" ? "self" : mode === "none" ? "none" : "presenter");
/** Everything a first draft is written from. Two drafts with the same key would be written alike. */
export const scriptKeyOf = (draft: Pick<Draft, "brief" | "seconds" | "language" | "platform" | "templateId" | "face" | "making">) =>
  JSON.stringify([draft.brief.trim(), draft.seconds, draft.language, draft.platform, draft.templateId, speakerOf(presenterOf(draft)?.mode)]);
export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
export const spokenSeconds = (beats: ScriptBeat[] | null) => Math.round(wordCount(scriptFromBeats(beats ?? [])) / SPEECH_RATE_WPS);

/* ───────────────────────── kept in this browser ───────────────────────── */

const storageKey = (workspaceId: string) => `faceful-new-project-v1:${workspaceId}`;
export function loadDraft(workspaceId: string): Draft | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(workspaceId)) ?? "null") as Draft | null;
    if (!value || value.version !== 1 || typeof value.brief !== "string") return null;
    // A take's local bytes do not survive a reload; the saved file does.
    const legacy = !("making" in value);
    return {
      ...value,
      // Drafts from before faces and making were separate start those two choices again.
      face: legacy ? null : (value.face ?? null),
      making: legacy ? "ai" : value.making,
      seconds: isLength(value.seconds) ? value.seconds : 30,
      copies: Array.isArray(value.copies) ? value.copies.filter((code) => typeof code === "string" && code !== value.language).slice(0, MAX_COPIES) : [],
      take: value.take ? { ...value.take, localUrl: null } : null,
    };
  } catch {
    return null;
  }
}
export function saveDraft(workspaceId: string, draft: Draft) {
  try {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify({ ...draft, take: draft.take ? { ...draft.take, localUrl: null } : null }));
  } catch {
    // Private windows and full storage: the flow still works, it just is not restored after a reload.
  }
}
export function clearDraft(workspaceId: string) {
  try {
    localStorage.removeItem(storageKey(workspaceId));
  } catch {
    /* nothing to clear */
  }
}

/** The face last used in this workspace, offered first next time. */
const lastFaceKey = (workspaceId: string) => `faceful-last-face-v1:${workspaceId}`;
export function loadLastFace(workspaceId: string): Face | null {
  try {
    const value = JSON.parse(localStorage.getItem(lastFaceKey(workspaceId)) ?? "null") as Face | null;
    return value && ["persona", "avatar", "none"].includes(value.kind) ? value : null;
  } catch {
    return null;
  }
}
export function saveLastFace(workspaceId: string, face: Face) {
  try {
    localStorage.setItem(lastFaceKey(workspaceId), JSON.stringify(face));
  } catch {
    /* only a convenience */
  }
}

/* ───────────────────────── style ───────────────────────── */

/** A first suggestion from the description's own words. Only a hint: the person picks. */
export function recommendTemplate(brief: string, templates: LibraryTemplate[]): string | null {
  const text = brief.toLowerCase();
  const byId = (id: string) => templates.find((template) => template.id === id || template.id.endsWith(`/${id}`) || template.id.endsWith(id))?.id ?? null;
  const rules: Array<[RegExp, string[]]> = [
    [/\bmyths?\b|μύθ|misconception|believe/, ["myth-react", "myth-fact"]],
    [/\b\d+\s+(signs?|things|tips|ways|steps|reasons|mistakes)\b|\b(signs|checklist)\b|σημάδια|λόγοι/, ["hosted-list"]],
    [/how (it|does|do|a|the)\b.*\bworks?\b|mechanism|πώς λειτουργ/, ["explainer", "window-explainer"]],
    [/%|percent|statistic|study|data|research|ποσοστ|έρευνα/, ["stat-story"]],
    [/\bfaq\b|questions?|asked|ρωτ|ερωτήσ/, ["faq-cards", "chat-qa", "patient-dialogue"]],
    [/timeline|what happens|stages?|after\b|στάδι/, ["window-explainer"]],
  ];
  for (const [pattern, ids] of rules) {
    if (!pattern.test(text)) continue;
    for (const id of ids) {
      const found = byId(id);
      if (found) return found;
    }
  }
  return byId("talking-tip") ?? templates[0]?.id ?? null;
}

/* ───────────────────────── rough preview ───────────────────────── */

/** Media keys for pictures that only exist in the preview (signed links, never saved into a project). */
export const STILL_PRESENTER = "still-presenter";
export const STILL_STYLE = "still-style";

/**
 * Words of the script with the moments the teleprompter heard each one. `reached[i]` is when the reader moved
 * past word i (seconds into the take); gaps are spread evenly between the nearest known moments.
 */
export function timedWords(script: string, reached: Array<number | undefined>, duration: number): TranscriptWord[] {
  const words = script.split(/\s+/).filter(Boolean);
  if (!words.length || duration <= 0) return [];
  // Recognition trails speech slightly; a word ends a little before it was recognised.
  const lag = 0.35;
  const ends: number[] = Array.from({ length: words.length });
  const known: Array<[index: number, time: number]> = [[-1, 0.2]];
  reached.forEach((time, index) => {
    if (time !== undefined && index < words.length) known.push([index, Math.max(0.2, time - lag)]);
  });
  known.push([words.length - 1 + 1e-9, Math.max(0.3, duration - 0.3)]);
  known.sort((a, b) => a[0] - b[0]);
  for (let k = 0; k < known.length - 1; k++) {
    const [fromIndex, fromTime] = known[k];
    const [toIndex, toTime] = known[k + 1];
    const first = Math.floor(fromIndex) + 1;
    const last = Math.min(words.length - 1, Math.floor(toIndex));
    const span = Math.max(1, toIndex - fromIndex);
    for (let i = first; i <= last; i++) ends[i] = fromTime + ((i - fromIndex) / span) * Math.max(0, toTime - fromTime);
  }
  let previous = 0.2;
  return words.map((word, index) => {
    const end = Math.min(duration, Math.max(previous + 0.05, ends[index] ?? previous + 0.3));
    const entry = { t: word.slice(0, 60), start: Math.round(previous * 100) / 100, end: Math.round(end * 100) / 100 };
    previous = end;
    return entry;
  });
}

/**
 * The rough preview: the script's captions and title card in the chosen colour, with the best picture available
 * right now (the recording, the presenter's photo or the style's poster). Nothing here is rendered or saved.
 */
export function previewComposition(input: {
  title: string;
  beats: ScriptBeat[];
  accent: string;
  presenter: Presenter | null;
  language: Language;
  take: Take | null;
  stills: { presenter: boolean; style: boolean };
}): Composition {
  const script = scriptFromBeats(input.beats);
  const take = input.take && input.take.durationSeconds >= 1 ? input.take : null;
  const base = draftComposition({ title: input.title || "Untitled", script: script || "…", brandColor: input.accent, captionPosition: "bottom", mediaDurationSeconds: take?.durationSeconds ?? null });
  const duration = base.durationSeconds;
  const mode = input.presenter?.mode ?? "none";
  const [presenterClip] = base.video;
  const still = (fileId: string) => ({ ...presenterClip, source: { kind: "file" as const, fileId }, media: "image" as const, volume: 0 });
  let video = base.video;
  let audio = base.audio;
  if (mode === "camera" && take) video = [{ ...presenterClip, source: { kind: "file", fileId: take.fileId } }];
  else if ((mode === "persona" || mode === "avatar" || mode === "voice") && input.stills.presenter) video = [still(STILL_PRESENTER)];
  else video = input.stills.style ? [still(STILL_STYLE)] : [];
  if (mode === "voice" && take)
    audio = [{ id: "voice", start: 0, end: duration, source: { kind: "file", fileId: take.fileId }, in: 0, role: "voice", volume: 1, fadeIn: 0, fadeOut: 0, loop: false }];
  const words = take?.words?.length ? take.words.filter((word) => word.end <= duration) : null;
  return compositionSchema.parse({
    ...base,
    video,
    audio,
    captions: words?.length ? captionsFromWords(words, 4, duration) : base.captions,
    transcript: words?.length ? { language: input.language, words, sourceFileId: take!.fileId } : null,
    // The "AI avatar" tag is for AI presenters only: a person's own recording is not one.
    labels: { aiAvatar: mode === "persona" || mode === "avatar", disclaimer: "" },
  });
}

/** What is saved to the project: the preview without its preview-only pictures. */
export function savedComposition(preview: Composition): Composition {
  const keep = (source: { kind: string; fileId?: string }) => source.kind !== "file" || !source.fileId?.startsWith("still-");
  return compositionSchema.parse({ ...preview, video: preview.video.filter((clip) => keep(clip.source)), audio: preview.audio.filter((clip) => keep(clip.source)) });
}
