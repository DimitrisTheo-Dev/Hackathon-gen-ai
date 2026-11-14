/**
 * The one-minute pitch as data: seven beats, and inside them the cues that toggle state.
 * Everything on screen is derived from the playhead time `t` (seconds); nothing else keeps time.
 */
export const TOTAL = 60;

export type BeatId = "intro" | "reveal" | "edit" | "agent" | "review" | "why" | "end";
export const BEATS: ReadonlyArray<{ id: BeatId; start: number; label: string }> = [
  { id: "intro", start: 0, label: "Presenter" },
  { id: "reveal", start: 8, label: "The studio" },
  { id: "edit", start: 14, label: "Direct by chat" },
  { id: "agent", start: 22, label: "Your agent, over MCP" },
  { id: "review", start: 30, label: "You approve" },
  { id: "why", start: 38, label: "Why it matters" },
  { id: "end", start: 52, label: "Faceful" },
];

/** Moments inside the beats. Each one only switches classes; the motion itself is CSS. */
export const CUE = {
  speak: 0.6,
  speakEnd: 6.3,
  zoomOut: 8.0, // 1.8s camera pull-back, from the first frame of the beat
  chrome: 9.9, // card chrome and the opening caption settle in
  promptFocus: 10.8, // the prompt that made her is highlighted
  askType: 14.2,
  askSend: 15.7,
  proposal: 16.5,
  apply: 18.9,
  saved: 19.2,
  terminalIn: 22.0,
  cmdType: 22.8,
  toolCall: 24.6,
  toolDone: 25.9,
  cardLand: 26.3,
  activity: 27.0,
  terminalOut: 30.0,
  reviewPress: 30.25,
  reviewIn: 30.6,
  slot: 31.3,
  boundary: 32.6,
  whyIn: 38.0,
  why1: 38.4,
  why2: 42.8,
  why3: 47.2,
  whyOut: 52.0,
  zoomIn: 52.0, // 1.8s camera push back into the presenter while the lines fade
  endText: 54.2,
} as const;
export type CueId = keyof typeof CUE;

/** Sorted cue times, so the page re-renders only when the playhead crosses one. */
const CUE_TIMES = [...new Set([...Object.values(CUE), ...BEATS.map((beat) => beat.start), TOTAL])].sort((a, b) => a - b);

/** The latest cue time at or before `t` (0 before the first). The page renders from this, not from `t`. */
export function cueTimeAt(t: number): number {
  let at = 0;
  for (const time of CUE_TIMES) if (time <= t + 1e-6) at = time;
  return at;
}

export function beatIndexAt(t: number): number {
  let index = 0;
  BEATS.forEach((beat, i) => { if (beat.start <= t + 1e-6) index = i; });
  return index;
}

/** The camera: on the presenter (intro, end) or pulled back to the whole studio. */
export function cameraAt(cueTime: number): "presenter" | "studio" | "end" {
  if (cueTime >= CUE.zoomIn) return "end";
  if (cueTime >= CUE.zoomOut) return "studio";
  return "presenter";
}

/** The reel caption, spoken in chunks the way short-form captions are. Times are seconds into the pitch. */
export const INTRO_CAPTION: ReadonlyArray<{ start: number; end: number; text: string }> = [
  { start: 0.6, end: 2.2, text: "Hi, I’m Eleni." },
  { start: 2.2, end: 3.5, text: "An hour ago" },
  { start: 3.5, end: 4.9, text: "I was a sentence" },
  { start: 4.9, end: 6.3, text: "in a chat box." },
];
export const OPENING_V1 = "Hi, I’m Eleni.";
export const OPENING_V2 = "Hi! I’m Eleni — so glad you’re here.";

/** The caption chunk showing at `t` during the intro (the last one holds once she stops speaking). */
export function captionIndexAt(t: number): number {
  let index = -1;
  INTRO_CAPTION.forEach((chunk, i) => { if (chunk.start <= t) index = i; });
  return index;
}

/** Text typed into the director chat and the terminal; the visible prefix is derived from `t`. */
export const ASK = "Make the opening warmer.";
export const PROMPT = "Make a 15-second Reel. Presenter: Eleni, warm and friendly. She says hi to the room — an hour ago she was a sentence in a chat box.";
export const AGENT_ASK = "Add a Greek version of Eleni’s opening to “Faceful pitch”.";

export function typedLength(text: string, t: number, start: number, seconds: number): number {
  if (t <= start) return 0;
  if (t >= start + seconds) return text.length;
  return Math.round(((t - start) / seconds) * text.length);
}
