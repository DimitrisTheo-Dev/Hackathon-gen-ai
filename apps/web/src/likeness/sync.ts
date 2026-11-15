/**
 * Read-along sync: follows a speaker through a script from running speech-to-text snapshots.
 *
 * Each call to `update` receives the whole running transcript (the shape live ASR emits: a snapshot that
 * replaces the previous one, with the tail still being revised). We match the last few spoken words against
 * a window of the script ahead of the current position, so skipped words, ad-libs and misrecognitions
 * (fuzzy word match, accents ignored for Greek) don't lose the place. The position never moves backwards
 * unless the speaker clearly restarts an earlier line. Pure.
 */

export interface ScriptWord {
  /** The word as written, punctuation attached, for display. */
  text: string;
  /** Lowercased, accents and punctuation removed, for matching. */
  norm: string;
}

export interface SyncOptions {
  /** How many script words ahead of the position a match may land (speaker skipped ahead). Default 40. */
  lookahead?: number;
  /** How many script words behind the position a match may land (speaker repeated a line). Default 6. */
  lookbehind?: number;
  /** Spoken words compared per update. Default 6. */
  window?: number;
  /** Minimum average word similarity, 0-1. Default 0.7. */
  threshold?: number;
}

// Greek letters in Latin, digraphs first. Names come back in either alphabet ("Μηνάς Κόντης" for "Minas
// Kontis" from a Greek recognizer, and the reverse), so script and speech are both compared in Latin.
const GREEK_PAIRS: [RegExp, string][] = [[/ου/g, "ou"], [/αι/g, "e"], [/ει|οι|υι/g, "i"], [/μπ/g, "mp"], [/ντ/g, "nt"], [/γγ|γκ/g, "g"], [/αυ/g, "av"], [/ευ/g, "ev"]];
const GREEK_LETTERS: Record<string, string> = { α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r", σ: "s", τ: "t", υ: "i", φ: "f", χ: "ch", ψ: "ps", ω: "o" };
// Recognizers write numbers as digits ("meet at 7"); scripts spell them out. Both become "#7".
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  first: "1st", second: "2nd", third: "3rd", fourth: "4th", fifth: "5th", sixth: "6th", seventh: "7th", eighth: "8th", ninth: "9th", tenth: "10th",
  ena: "1", mia: "1", enas: "1", dio: "2", tria: "3", tris: "3", tessera: "4", tesseris: "4", pente: "5", exi: "6", epta: "7", efta: "7",
  ochto: "8", okto: "8", enea: "9", ennea: "9", ennia: "9", deka: "10", endeka: "11", dodeka: "12",
};

export function normalizeWord(word: string): string {
  let norm = word
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ς/g, "σ")
    .replace(/[^\p{L}\p{N}]/gu, "");
  if (/[α-ω]/.test(norm)) {
    for (const [pattern, latin] of GREEK_PAIRS) norm = norm.replace(pattern, latin);
    norm = norm.replace(/[α-ω]/g, (letter) => GREEK_LETTERS[letter] ?? letter);
  }
  const number = NUMBER_WORDS[norm] ?? (/^\d+(st|nd|rd|th)?$/.test(norm) ? norm : null);
  return number ? `#${number}` : norm;
}

/**
 * How a word sounds, roughly: voiced and unvoiced pairs, c/k, ph/f, close vowels and doubled letters fold
 * together. "Condis" and "Kontis", "Meenas" and "Minas" get the same key. Names are where recognizers differ
 * most from the script, and no phrase list can be sent to the live model (it refuses one).
 */
export function soundKey(norm: string): string {
  return norm
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/ch/g, "k")
    .replace(/h/g, "")
    .replace(/[cqg]/g, "k")
    .replace(/x/g, "ks")
    .replace(/d/g, "t")
    .replace(/b/g, "p")
    .replace(/[vw]/g, "f")
    .replace(/z/g, "s")
    .replace(/[eyj]/g, "i")
    .replace(/u/g, "o")
    .replace(/(.)\1+/g, "$1");
}

export function tokenizeScript(script: string): ScriptWord[] {
  return script
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => ({ text, norm: normalizeWord(text) }))
    .filter((word) => word.norm.length > 0);
}

export function tokenizeSpeech(transcript: string): string[] {
  return transcript.split(/\s+/).map(normalizeWord).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

/** 1 for identical words, falling off with edit distance. Short words must match exactly. */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest <= 2) return 0;
  let similarity = 1 - levenshtein(a, b) / longest;
  // A prefix is the half-spoken word still being revised by the recognizer.
  if (a.length >= 3 && b.startsWith(a)) similarity = Math.max(similarity, 0.85);
  // Spelled differently, sounds the same: a little below an exact match.
  if (longest >= 3 && !a.startsWith("#") && !b.startsWith("#")) {
    const ka = soundKey(a);
    const kb = soundKey(b);
    similarity = Math.max(similarity, 0.9 * (1 - levenshtein(ka, kb) / Math.max(ka.length, kb.length, 1)));
  }
  return similarity;
}

/**
 * Recognizers split brand names ("face full" for Faceful): rejoin neighbours that spell one of `targets`.
 * 0.85 rather than an exact match, because the halves are real words and come back spelled as such.
 */
export function mergeSplitWords(tokens: string[], targets: string[]): string[] {
  const merged: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const joined = i + 1 < tokens.length ? tokens[i] + tokens[i + 1] : "";
    // Not when the second word is a script word itself: "choose a" is two words, not "choosea".
    const secondIsWord = joined && targets.some((target) => wordSimilarity(tokens[i + 1], target) >= 0.85);
    if (joined && !secondIsWord && targets.some((target) => wordSimilarity(joined, target) >= 0.85)) {
      merged.push(joined);
      i++;
    } else merged.push(tokens[i]);
  }
  return merged;
}

export interface ReadAlongSync {
  readonly words: ScriptWord[];
  /** Index of the next word to be read; words before it are done. */
  readonly position: number;
  /** Feed the running transcript; returns the new position. */
  update(transcript: string): number;
  /** Jump to a word, or back to the start. */
  reset(position?: number): void;
}

export function createReadAlongSync(script: string, options: SyncOptions = {}): ReadAlongSync {
  const words = tokenizeScript(script);
  const lookahead = options.lookahead ?? 40;
  const lookbehind = options.lookbehind ?? 6;
  const windowSize = options.window ?? 6;
  const threshold = options.threshold ?? 0.7;
  let position = 0;

  function update(transcript: string): number {
    if (!words.length) return position;
    const from = Math.max(0, position - lookbehind);
    const to = Math.min(words.length - 1, position + lookahead);
    const targets = words.slice(from, to + 1).map((word) => word.norm);
    const spoken = mergeSplitWords(tokenizeSpeech(transcript).slice(-(windowSize + 2)), targets).slice(-windowSize);
    if (!spoken.length) return position;

    let best = { end: -1, score: 0 };
    for (let end = from; end <= to; end++) {
      // Align the spoken tail so its last word sits on script[end]; compare backwards.
      let total = 0;
      let compared = 0;
      for (let k = 0; k < spoken.length; k++) {
        const scriptIndex = end - k;
        if (scriptIndex < 0) break;
        total += wordSimilarity(spoken[spoken.length - 1 - k], words[scriptIndex].norm);
        compared++;
      }
      if (!compared) continue;
      const lastMatches = wordSimilarity(spoken[spoken.length - 1], words[end].norm) >= threshold;
      if (!lastMatches) continue;
      const average = total / compared;
      // Longer agreement is stronger evidence; nearer the position wins ties.
      const score = average * Math.min(1, 0.4 + compared * 0.15) - Math.abs(end + 1 - position) * 0.002;
      if (average >= threshold - 0.15 * (compared > 1 ? 1 : 0) && score > best.score) best = { end, score };
    }
    if (best.end >= 0) {
      const next = best.end + 1;
      // Forward always; backward only for a confident multi-word match (the speaker re-read a line).
      if (next >= position || spoken.length >= 3) position = next;
    }
    return position;
  }

  return {
    words,
    get position() {
      return position;
    },
    update,
    reset(next = 0) {
      position = Math.max(0, Math.min(words.length, next));
    },
  };
}
