/**
 * The doctor-story variant of the one-minute pitch: the same motion, different sample content.
 *
 * Timing is not copied. Every beat and cue time is re-exported from the original timeline, so the two pages
 * cannot drift apart; only the sample text lives here. The text is topics and questions only: no medical
 * claims, no clinic names, no numbers.
 */
export { BEATS, CUE, TOTAL, beatIndexAt, cameraAt, cueTimeAt, typedLength, type CueId } from "../pitch/timeline";

/** The reel caption in the opening. Same chunk times as the original; the words are the doctor's sample Reel. */
export const INTRO_CAPTION: ReadonlyArray<{ start: number; end: number; text: string }> = [
  { start: 0.6, end: 2.2, text: "Κατάψυξη ωαρίων." },
  { start: 2.2, end: 3.5, text: "Μια ερώτηση" },
  { start: 3.5, end: 4.9, text: "που μου κάνουν" },
  { start: 4.9, end: 6.3, text: "οι ασθενείς μου." },
];
/**
 * ?clip=1 asks for the local clip of the doctor (see PitchDoctorPage). In it he talks about infertility, so the
 * draft he presents takes that topic; without it the drawing presents egg freezing, as before.
 */
export const CLIP_MODE = typeof location !== "undefined" && new URLSearchParams(location.search).get("clip") === "1";

export const OPENING_V1 = CLIP_MODE ? "Υπογονιμότητα." : "Κατάψυξη ωαρίων.";
export const OPENING_V2 = CLIP_MODE ? "Υπογονιμότητα: πότε να ζητήσετε βοήθεια;" : "Κατάψυξη ωαρίων: σε ποιες απευθύνεται;";

/** The caption chunk showing at `t` during the intro (the last one holds once he stops speaking). */
export function captionIndexAt(t: number): number {
  let index = -1;
  INTRO_CAPTION.forEach((chunk, i) => { if (chunk.start <= t) index = i; });
  return index;
}

/** Names used across the studio illustration. */
export const PRESENTER = "Dr Panagiotis";
export const PROJECT = "Patient questions";
export const DRAFT_TITLE = CLIP_MODE ? "Υπογονιμότητα" : "Κατάψυξη ωαρίων";
export const AGENT_DRAFT_TITLE = CLIP_MODE ? "Infertility · English" : "Egg freezing · English";
export const AGENT_DRAFT_CAPTION = CLIP_MODE ? "Infertility: when to ask for help?" : "Egg freezing: who is it for?";

/** Text typed into the director chat and the terminal; the visible prefix is derived from `t`. */
export const ASK = "Open with the question.";
export const PROMPT = `Make a short Reel in Greek. Presenter: ${PRESENTER}, calm and clear. He answers one question his patients ask about ${CLIP_MODE ? "infertility" : "egg freezing"}.`;
export const AGENT_ASK = `Add an English version of the opening to “${PROJECT}”.`;
