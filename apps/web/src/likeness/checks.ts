/**
 * Liveness checks for a likeness capture, run in the browser on what FaceLandmarker and the microphone saw.
 * They stop the easy cheats: holding up a photo, playing back a video, someone else reading the consent.
 * They are evidence kept with the consent, not proof: the browser reports them, so the engine stores the
 * result without treating it as verified. Pure, unit tested.
 * Blink and lip sync are advisory for now (kept with the consent, not blocking) until their thresholds are
 * tuned on real captures.
 *
 *   poses       all five angles were held (the four turns came in a random order)
 *   one_face    exactly one face in frame nearly all the time
 *   smooth      no jumps in head angle between frames (a cut or a swapped video)
 *   blink       the eyes blinked at least once (a printed photo never does)
 *   phrases     each phrase, including the consent statement, was actually said
 *   lip_sync    the mouth opened and closed with the voice (someone off camera reading fails)
 *   duration    enough speech to learn the mouth and the voice from
 */
import type { PoseId } from "./pose";
import { mergeSplitWords, tokenizeScript, tokenizeSpeech, wordSimilarity } from "./sync";

export interface FaceFrame {
  /** ms since the step started */
  t: number;
  /** faces FaceLandmarker found (it is asked for up to two) */
  faces: number;
  yaw?: number;
  pitch?: number;
  /** max of eyeBlinkLeft / eyeBlinkRight, 0..1 */
  blink?: number;
  /** jawOpen, 0..1 */
  jaw?: number;
  /** microphone RMS at this frame, 0..1 (speech step only) */
  audio?: number;
}

export interface CaptureEvidence {
  posesCaptured: PoseId[];
  scanFrames: FaceFrame[];
  speechFrames: FaceFrame[];
  phrases: string[];
  transcript: string;
  speechMs: number;
  /** Per phrase, the share of its words heard at any point while reading (createPhraseTracker). */
  phraseCoverage?: number[];
}

export type CheckId = "poses" | "one_face" | "smooth" | "blink" | "phrases" | "lip_sync" | "duration";

export interface CheckResult {
  id: CheckId;
  label: string;
  passed: boolean;
  /** Whether a failure blocks saving. */
  required: boolean;
  /** The measured value, kept with the consent for review. */
  value: number;
}

export interface LivenessReport {
  passed: boolean;
  checks: CheckResult[];
}

export const PHRASE_COVERAGE = 0.7;
export const LIP_SYNC_MIN = 0.2;
export const MIN_SPEECH_MS = 8000;

/** Share of a phrase's words heard in the transcript (fuzzy, accents ignored). */
export function phraseCoverage(phrase: string, transcript: string): number {
  const words = tokenizeScript(phrase).map((word) => word.norm);
  if (!words.length) return 1;
  const heard = mergeSplitWords(tokenizeSpeech(transcript), words);
  const found = words.filter((word) => heard.some((spoken) => wordSimilarity(spoken, word) >= 0.75)).length;
  return found / words.length;
}

/**
 * Which words of each phrase have been heard so far. Feed it every transcript snapshot. The final snapshot
 * alone is not enough: a browser recognizer starts a fresh transcript whenever it restarts, and a recognizer
 * that replaces another knows nothing of what the first one heard. This keeps what any of them heard.
 */
export function createPhraseTracker(phrases: string[]) {
  const words = phrases.map((phrase) => tokenizeScript(phrase).map((word) => word.norm));
  const heard = words.map((list) => list.map(() => false));
  return {
    update(transcript: string) {
      const spoken = tokenizeSpeech(transcript);
      if (!spoken.length) return;
      words.forEach((list, p) => {
        const merged = mergeSplitWords(spoken, list);
        list.forEach((word, w) => {
          if (!heard[p][w] && merged.some((said) => wordSimilarity(said, word) >= 0.75)) heard[p][w] = true;
        });
      });
    },
    /** 0..1 per phrase. */
    coverage: () => heard.map((list) => (list.length ? list.filter(Boolean).length / list.length : 1)),
  };
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va && vb ? cov / Math.sqrt(va * vb) : 0;
}

/** Blinks: the eyes closing past 0.5 after being open below 0.3. */
export function countBlinks(frames: FaceFrame[]): number {
  let open = true;
  let blinks = 0;
  for (const frame of frames) {
    if (frame.blink === undefined) continue;
    if (open && frame.blink > 0.5) {
      blinks++;
      open = false;
    } else if (!open && frame.blink < 0.3) open = true;
  }
  return blinks;
}

/** Largest head-angle change between neighbouring frames under 150 ms apart, in degrees. */
export function largestJump(frames: FaceFrame[]): number {
  let largest = 0;
  let previous: FaceFrame | null = null;
  for (const frame of frames) {
    if (frame.faces !== 1 || frame.yaw === undefined || frame.pitch === undefined) {
      previous = null;
      continue;
    }
    if (previous && frame.t - previous.t < 150) {
      largest = Math.max(largest, Math.abs(frame.yaw - previous.yaw!), Math.abs(frame.pitch - previous.pitch!));
    }
    previous = frame;
  }
  return largest;
}

/**
 * Correlation of mouth opening and voice loudness. Both are smoothed over a few frames, and the best of small
 * time shifts (up to 5 frames either way) is taken: the voice level is read when the tracker's result comes
 * back, so it trails the video frame by the tracking time, and speech leads or lags the jaw slightly anyway.
 */
export function lipSyncScore(frames: FaceFrame[], maxLag = 5): number {
  const usable = frames.filter((frame) => frame.faces === 1 && frame.jaw !== undefined && frame.audio !== undefined);
  if (usable.length < 30) return 0;
  const smooth = (values: number[]) =>
    values.map((_, i) => {
      const window = values.slice(Math.max(0, i - 3), i + 4);
      return window.reduce((sum, value) => sum + value, 0) / window.length;
    });
  const jaw = smooth(usable.map((frame) => frame.jaw!));
  const audio = smooth(usable.map((frame) => frame.audio!));
  let best = -1;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const a = lag >= 0 ? jaw.slice(0, jaw.length - lag) : jaw.slice(-lag);
    const b = lag >= 0 ? audio.slice(lag) : audio.slice(0, audio.length + lag);
    best = Math.max(best, pearson(a, b));
  }
  return best;
}

/**
 * How long the microphone has carried a voice, in ms: the time covered by frames whose level is above
 * `threshold`. Used while reading aloud to notice a transcription service that hears nothing.
 */
export function voicedMs(frames: FaceFrame[], threshold = 0.015): number {
  let total = 0;
  for (let i = 1; i < frames.length; i++) {
    const gap = frames[i].t - frames[i - 1].t;
    // A long gap is a stalled tracker, not a held note.
    if ((frames[i].audio ?? 0) > threshold && gap < 500) total += gap;
  }
  return total;
}

const round = (value: number) => Math.round(value * 100) / 100;

export function evaluateLiveness(evidence: CaptureEvidence): LivenessReport {
  const all = [...evidence.scanFrames, ...evidence.speechFrames];
  const oneFace = all.length ? all.filter((frame) => frame.faces === 1).length / all.length : 0;
  const jump = largestJump(evidence.scanFrames);
  const blinks = countBlinks(all);
  // Each phrase counts by the better of what was heard along the way and what the final transcript holds.
  const coverage = evidence.phrases.length ? Math.min(...evidence.phrases.map((phrase, i) => Math.max(evidence.phraseCoverage?.[i] ?? 0, phraseCoverage(phrase, evidence.transcript)))) : 0;
  const sync = lipSyncScore(evidence.speechFrames);
  const posesDone = new Set(evidence.posesCaptured).size;
  const checks: CheckResult[] = [
    { id: "poses", label: "Five head angles", passed: posesDone >= 5, required: true, value: posesDone },
    { id: "one_face", label: "One face in view", passed: oneFace >= 0.9, required: true, value: round(oneFace) },
    { id: "smooth", label: "Natural movement", passed: jump < 30, required: true, value: round(jump) },
    { id: "blink", label: "Blinking", passed: blinks >= 1, required: false, value: blinks },
    { id: "phrases", label: "Phrases spoken", passed: coverage >= PHRASE_COVERAGE, required: true, value: round(coverage) },
    { id: "lip_sync", label: "Lips match voice", passed: sync >= LIP_SYNC_MIN, required: false, value: round(sync) },
    { id: "duration", label: "Enough speech", passed: evidence.speechMs >= MIN_SPEECH_MS, required: true, value: Math.round(evidence.speechMs) },
  ];
  return { passed: checks.every((check) => check.passed || !check.required), checks };
}

/**
 * Mean perceived brightness (Rec. 709 luma), 0..1, of RGBA pixels: a small sample of the camera picture, so the
 * scan can ask for more light when it cannot find a face in a dark room.
 */
export function meanLuma(rgba: ArrayLike<number>): number {
  const pixels = Math.floor(rgba.length / 4);
  if (!pixels) return 0;
  let sum = 0;
  for (let i = 0; i < pixels * 4; i += 4) sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
  return sum / pixels / 255;
}
