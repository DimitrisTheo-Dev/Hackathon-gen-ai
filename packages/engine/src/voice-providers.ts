/**
 * Speech services that turn a script into a voiceover, with no imports, so the engine and the render worker
 * (workers/reel-render, which runs outside the pnpm workspace) share one copy.
 *
 *   azure       Microsoft Text to Speech (Azure AI Speech). Key + region, or key + endpoint. The default stock voice.
 *   elevenlabs  A voice stored at ElevenLabs (persona clone, or a stock voice when ELEVENLABS_VOICE_ID is set).
 *   cartesia    A voice stored at Cartesia (persona clone, or a stock voice when CARTESIA_VOICE_ID is set).
 *   fal         A model on fal.ai; MiniMax speech with a cloned voice id.
 *
 * Every call returns MP3 bytes, their real duration (read from the MP3 frames) and word timings. The services used
 * here return no word timings, so words are spread over the measured speech by length, with pauses at punctuation:
 * close enough for captions, which page every few words.
 */

export type VoiceProvider = "azure" | "elevenlabs" | "cartesia" | "fal";
/** One way to say a script: a service, its model and voice, and plain options (speed, emotion). Never a secret. */
export interface VoiceSpec {
  provider: VoiceProvider;
  /** Vendor model or fal endpoint id. Azure ignores it. */
  model: string | null;
  /** Voice id at the vendor (Azure: a voice name such as el-GR-AthinaNeural). */
  voice: string;
  /** Shown in the project's files and the audit trail. */
  name: string;
  settings?: Record<string, unknown>;
}
export interface VoiceKeys {
  azure: { key: string; region: string | null; endpoint: string | null; voice: string | null; voices: Record<string, string> } | null;
  elevenlabs: { key: string; voice: string | null; model: string } | null;
  cartesia: { key: string; voice: string | null; model: string } | null;
  fal: { key: string } | null;
}
export interface SpokenWord {
  t: string;
  start: number;
  end: number;
}
export interface Speech {
  bytes: Uint8Array;
  mime: "audio/mpeg";
  durationSeconds: number;
  words: SpokenWord[];
  spec: VoiceSpec;
}
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Longest script sent in one request. A reel is at most three minutes, about 450 words. */
const MAX_SPOKEN_CHARACTERS = 5000;
const TIMEOUT_MS = 90_000;

const trimmed = (value: string | undefined) => value?.trim() || null;

/** Reads the speech settings from the environment. Missing keys leave that service out; nothing here throws. */
export function voiceKeysFrom(env: Record<string, string | undefined>): VoiceKeys {
  const azureKey = trimmed(env.AZURE_SPEECH_KEY);
  const region = trimmed(env.AZURE_SPEECH_REGION)?.toLowerCase() ?? null;
  const endpoint = trimmed(env.AZURE_SPEECH_ENDPOINT)?.replace(/\/+$/, "") ?? null;
  const voices: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const match = /^AZURE_TTS_VOICE_([A-Z]{2})$/.exec(name);
    if (match && trimmed(value)) voices[match[1].toLowerCase()] = value!.trim();
  }
  const usableRegion = region && /^[a-z0-9]{2,40}$/.test(region) ? region : null;
  const usableEndpoint = endpoint && /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/i.test(endpoint) ? endpoint : null;
  const elevenKey = trimmed(env.ELEVENLABS_API_KEY) ?? trimmed(env.ELEVEN_API_KEY);
  const cartesiaKey = trimmed(env.CARTESIA_API_KEY);
  const falKey = trimmed(env.FAL_KEY);
  return {
    azure: azureKey && (usableRegion || usableEndpoint) ? { key: azureKey, region: usableRegion, endpoint: usableEndpoint, voice: trimmed(env.AZURE_TTS_VOICE), voices } : null,
    elevenlabs: elevenKey ? { key: elevenKey, voice: trimmed(env.ELEVENLABS_VOICE_ID), model: trimmed(env.ELEVENLABS_MODEL) ?? "eleven_multilingual_v2" } : null,
    cartesia: cartesiaKey ? { key: cartesiaKey, voice: trimmed(env.CARTESIA_VOICE_ID), model: trimmed(env.CARTESIA_MODEL) ?? "sonic-2" } : null,
    fal: falKey ? { key: falKey } : null,
  };
}

/** Azure voices that read each language natively. Anything else is read by a multilingual voice. */
const AZURE_NATIVE: Record<string, string> = { en: "en-US-AvaMultilingualNeural", el: "el-GR-AthinaNeural" };
const AZURE_MULTILINGUAL = "en-US-AvaMultilingualNeural";
const LOCALES: Record<string, string> = { en: "en-US", el: "el-GR", de: "de-DE", fr: "fr-FR", es: "es-ES", it: "it-IT", pt: "pt-PT", nl: "nl-NL", pl: "pl-PL", tr: "tr-TR", ar: "ar-SA", zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", ru: "ru-RU", uk: "uk-UA", ro: "ro-RO", bg: "bg-BG", sv: "sv-SE", da: "da-DK", fi: "fi-FI", no: "nb-NO", cs: "cs-CZ", hu: "hu-HU", hi: "hi-IN" };
/** "el" → "el-GR"; a regional code ("pt-BR") is kept. */
function localeOf(language: string): string {
  const [base, region] = language.split("-");
  if (region) return `${base.toLowerCase()}-${region.toUpperCase()}`;
  return LOCALES[base.toLowerCase()] ?? "en-US";
}

/** The stock voices to try for a language, best first, among the services that are configured. */
export function defaultVoices(keys: VoiceKeys, language: string): VoiceSpec[] {
  const base = language.split("-")[0].toLowerCase();
  const specs: VoiceSpec[] = [];
  if (keys.azure) {
    const voice = keys.azure.voices[base] ?? keys.azure.voice ?? AZURE_NATIVE[base] ?? AZURE_MULTILINGUAL;
    specs.push({ provider: "azure", model: null, voice, name: `Microsoft ${voice.replace(/Neural$/, "").split("-").slice(2).join(" ") || voice}` });
  }
  if (keys.elevenlabs?.voice) specs.push({ provider: "elevenlabs", model: keys.elevenlabs.model, voice: keys.elevenlabs.voice, name: "ElevenLabs stock voice" });
  if (keys.cartesia?.voice) specs.push({ provider: "cartesia", model: keys.cartesia.model, voice: keys.cartesia.voice, name: "Cartesia stock voice" });
  return specs;
}

const canSpeak = (keys: VoiceKeys, spec: VoiceSpec) => Boolean(keys[spec.provider]);

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The Azure Text to Speech REST address: the resource's own endpoint when given, else the region's. */
export function azureTtsUrl(azure: NonNullable<VoiceKeys["azure"]>): string {
  if (azure.endpoint) {
    // A Speech resource's custom domain (https://<name>.cognitiveservices.azure.com) or a full TTS address.
    return azure.endpoint.endsWith("/cognitiveservices/v1") ? azure.endpoint : `${azure.endpoint}/tts/cognitiveservices/v1`;
  }
  return `https://${azure.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

/** SSML for one voice. A voice from another locale (a multilingual one) is told the script's language. */
export function azureSsml(text: string, voice: string, language: string, settings: Record<string, unknown> = {}): string {
  const locale = localeOf(language);
  const voiceLocale = /^[a-z]{2,3}-[A-Z]{2}/.exec(voice)?.[0] ?? locale;
  const rate = typeof settings.speed === "number" && settings.speed >= 0.5 && settings.speed <= 2 ? `${Math.round((settings.speed - 1) * 100)}%` : null;
  let body = escapeXml(text);
  if (rate) body = `<prosody rate="${rate}">${body}</prosody>`;
  if (voiceLocale.toLowerCase() !== locale.toLowerCase()) body = `<lang xml:lang="${locale}">${body}</lang>`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voiceLocale}"><voice name="${escapeXml(voice)}">${body}</voice></speak>`;
}

async function failure(response: Response, service: string): Promise<Error> {
  const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
  return new Error(`${service} answered ${response.status}${detail ? `: ${detail}` : ""}`);
}
async function mp3(response: Response, service: string): Promise<Uint8Array> {
  if (!response.ok) throw await failure(response, service);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 200) throw new Error(`${service} returned no audio.`);
  return bytes;
}

async function azure(fetcher: Fetch, keys: VoiceKeys, spec: VoiceSpec, text: string, language: string) {
  const azure = keys.azure!;
  const response = await fetcher(azureTtsUrl(azure), {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": azure.key, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3", "User-Agent": "faceful-voice" },
    body: azureSsml(text, spec.voice, language, spec.settings),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return mp3(response, "Microsoft Text to Speech");
}

async function elevenlabs(fetcher: Fetch, keys: VoiceKeys, spec: VoiceSpec, text: string, language: string) {
  const eleven = keys.elevenlabs!;
  const response = await fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(spec.voice)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": eleven.key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: spec.model ?? eleven.model, language_code: language.split("-")[0], ...(spec.settings?.voice_settings ? { voice_settings: spec.settings.voice_settings } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return mp3(response, "ElevenLabs");
}

async function cartesia(fetcher: Fetch, keys: VoiceKeys, spec: VoiceSpec, text: string, language: string) {
  const cartesia = keys.cartesia!;
  const { speed, emotion } = spec.settings ?? {};
  const response = await fetcher("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: { "X-API-Key": cartesia.key, "Cartesia-Version": "2025-04-16", "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: spec.model ?? cartesia.model,
      transcript: text,
      voice: { mode: "id", id: spec.voice },
      language: language.split("-")[0],
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
      ...(typeof speed === "number" || typeof speed === "string" || emotion ? { generation_config: { ...(speed !== undefined ? { speed } : {}), ...(emotion ? { emotion } : {}) } } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return mp3(response, "Cartesia");
}

const LANGUAGE_BOOST: Record<string, string> = { en: "English", el: "Greek", de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese", tr: "Turkish", ar: "Arabic", ru: "Russian" };
async function fal(fetcher: Fetch, keys: VoiceKeys, spec: VoiceSpec, text: string, language: string) {
  const model = spec.model ?? "";
  if (!/^fal-ai\/minimax\/[a-z0-9.-]+$/.test(model)) throw new Error(`fal model ${model || "(none)"} is not supported for voiceovers here.`);
  const { speed, emotion, language_boost } = spec.settings ?? {};
  const response = await fetcher(`https://fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${keys.fal!.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice_setting: { voice_id: spec.voice, speed: typeof speed === "number" ? speed : 1, vol: 1, pitch: 0, ...(typeof emotion === "string" ? { emotion } : {}) },
      language_boost: typeof language_boost === "string" ? language_boost : (LANGUAGE_BOOST[language.split("-")[0]] ?? "auto"),
      output_format: "url",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw await failure(response, "fal");
  const result = (await response.json()) as { audio?: { url?: string } };
  const url = result.audio?.url;
  if (!url?.startsWith("https://")) throw new Error("fal returned no audio.");
  return mp3(await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }), "fal");
}

const SERVICES = { azure, elevenlabs, cartesia, fal } as const;

/** Says `text` with one voice. Throws with a short, key-free reason when the service refuses or is not configured. */
async function speak(fetcher: Fetch, keys: VoiceKeys, spec: VoiceSpec, text: string, language: string): Promise<Speech> {
  if (!canSpeak(keys, spec)) throw new Error(`${spec.provider} is not connected here.`);
  const script = text.replace(/\s+/g, " ").trim().slice(0, MAX_SPOKEN_CHARACTERS);
  if (!script) throw new Error("There is nothing to say.");
  const bytes = await SERVICES[spec.provider](fetcher, keys, spec, script, language);
  const durationSeconds = mp3Duration(bytes);
  if (!durationSeconds) throw new Error(`${spec.provider} returned audio that is not an MP3.`);
  return { bytes, mime: "audio/mpeg", durationSeconds, words: spreadWords(script, durationSeconds), spec };
}

/**
 * Tries each voice in order and returns the first that works, with the reasons the others failed. Null when none
 * worked (or none was given), so the caller decides what a missing voice means.
 */
export async function speakFirst(fetcher: Fetch, keys: VoiceKeys, specs: VoiceSpec[], text: string, language: string): Promise<{ speech: Speech | null; failures: string[] }> {
  const failures: string[] = [];
  for (const spec of specs) {
    try {
      return { speech: await speak(fetcher, keys, spec, text, language), failures };
    } catch (error) {
      failures.push(`${spec.name}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240));
    }
  }
  return { speech: null, failures };
}

/* ───────────────────────── timing ───────────────────────── */

const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as Record<number, number[]>;

/** Seconds of audio in an MPEG layer III file, by walking its frames. Zero when it is not one. */
export function mp3Duration(bytes: Uint8Array): number {
  let offset = 0;
  // An ID3v2 tag: 10-byte header, size as four 7-bit bytes.
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length > 10)
    offset = 10 + ((bytes[6] & 0x7f) << 21) + ((bytes[7] & 0x7f) << 14) + ((bytes[8] & 0x7f) << 7) + (bytes[9] & 0x7f);
  let seconds = 0;
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
      // Not a frame header: resynchronise (some encoders pad between frames).
      offset++;
      continue;
    }
    const version = (bytes[offset + 1] >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (bytes[offset + 1] >> 1) & 0x03; // 1 = layer III
    const bitrateIndex = bytes[offset + 2] >> 4;
    const rateIndex = (bytes[offset + 2] >> 2) & 0x03;
    const padding = (bytes[offset + 2] >> 1) & 0x01;
    const rates = SAMPLE_RATES[version];
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3 || !rates) {
      offset++;
      continue;
    }
    const bitrate = BITRATES[version === 3 ? 1 : 2][bitrateIndex] * 1000;
    const sampleRate = rates[rateIndex];
    const samples = version === 3 ? 1152 : 576;
    const length = Math.floor((samples / 8) * (bitrate / sampleRate)) + padding;
    if (length < 4) break;
    seconds += samples / sampleRate;
    frames++;
    offset += length;
  }
  return frames >= 2 ? Math.round(seconds * 1000) / 1000 : 0;
}

/**
 * Word timings for speech of a known length: each word's share follows its letters, with a pause after commas and
 * sentence ends, and a little silence at both ends (services pad the audio slightly).
 */
export function spreadWords(text: string, durationSeconds: number): SpokenWord[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length || durationSeconds <= 0) return [];
  const lead = Math.min(0.15, durationSeconds * 0.03);
  const tail = Math.min(0.3, durationSeconds * 0.05);
  const weights = words.map((word) => Math.max(2, word.replace(/[^\p{L}\p{N}]/gu, "").length) + 1);
  const pauses = words.map((word): number => (/[.!?;…]["”’»)]?$/.test(word) ? 4 : /[,:—–]["”’»)]?$/.test(word) ? 2 : 0));
  const total = weights.reduce((sum, value) => sum + value, 0) + pauses.reduce((sum, value) => sum + value, 0);
  const unit = Math.max(0, durationSeconds - lead - tail) / total;
  let at = lead;
  const round = (value: number) => Math.round(value * 100) / 100;
  return words.map((word, index) => {
    const start = at;
    const end = start + weights[index] * unit;
    at = end + pauses[index] * unit;
    return { t: word.slice(0, 60), start: round(start), end: round(Math.min(durationSeconds, end)) };
  });
}

/* ───────────────────────── the timeline ───────────────────────── */

interface Timed {
  id: string;
  start: number;
  end: number;
}
type Source = { kind: "file"; fileId: string } | { kind: "url"; url: string } | { kind: "item_media" };
/** The parts of a reel timeline (packages/contracts/src/composition.ts) a voiceover touches. */
export interface Timeline {
  durationSeconds: number;
  video: Array<Timed & { layer: number; media: string; volume: number; source: Source }>;
  audio: Array<Timed & { role: string; volume: number; source: Source }>;
  cards: Timed[];
  captions: Array<Timed & { text: string }>;
  transcript: { language: string; words: SpokenWord[]; sourceFileId: string | null } | null;
}

/** Someone already speaks: a voice clip, or a main-picture video (presenter render or camera take) playing its sound. */
export function speaksAlready(timeline: Timeline, itemHasMedia: boolean): boolean {
  if (timeline.audio.some((clip) => clip.role === "voice" && clip.volume > 0)) return true;
  return timeline.video.some((clip) => clip.layer === 0 && clip.media === "video" && clip.volume > 0 && (clip.source.kind !== "item_media" || itemHasMedia));
}

const VOICE_CLIP_ID = "voiceover";
const LEAD_SECONDS = 0.2;
const TAIL_SECONDS = 0.6;
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Caption pages: break at sentence ends, after four words, or at a pause over 0.6 s (as captionsFromWords does). */
function pages(words: SpokenWord[], lastEnd: number): Array<Timed & { text: string }> {
  const groups: SpokenWord[][] = [];
  let page: SpokenWord[] = [];
  words.forEach((word, index) => {
    page.push(word);
    const next = words[index + 1];
    if (page.length >= 4 || /[.!?;…:;]["”’»)]?$/.test(word.t) || (next && next.start - word.end > 0.6)) {
      groups.push(page);
      page = [];
    }
  });
  if (page.length) groups.push(page);
  return groups.slice(0, 400).map((entry, index) => {
    const next = groups[index + 1];
    const last = entry[entry.length - 1];
    const end = next && next[0].start - last.end < 0.6 ? next[0].start : !next ? lastEnd : last.end;
    return { id: `cap-${index + 1}`, start: round2(entry[0].start), end: round2(Math.max(end, entry[0].start + 0.04)), text: entry.map((word) => word.t).join(" ").slice(0, 140) };
  });
}

/**
 * The timeline with a voiceover laid in from the start: the voice clip, word timings, captions paged on those words,
 * and a length that fits the speech (up to `maxSeconds`). Pictures and music that ran to the old end run to the new one.
 */
export function layVoiceover<T extends Timeline>(timeline: T, voice: { source: Source; durationSeconds: number; words: SpokenWord[]; language: string }, maxSeconds = 180): T {
  const spoken = Math.min(voice.durationSeconds, maxSeconds - LEAD_SECONDS);
  const duration = round2(Math.min(maxSeconds, Math.max(timeline.durationSeconds, LEAD_SECONDS + spoken + TAIL_SECONDS)));
  const stretch = <C extends Timed>(clip: C): C => (clip.end >= timeline.durationSeconds - 0.01 ? { ...clip, end: duration } : clip);
  const words = voice.words
    .map((word) => ({ t: word.t, start: round2(LEAD_SECONDS + word.start), end: round2(LEAD_SECONDS + word.end) }))
    .filter((word) => word.end <= duration && word.end >= word.start);
  const taken = new Set([...timeline.video, ...timeline.audio, ...timeline.cards].map((clip) => clip.id));
  let id = VOICE_CLIP_ID;
  for (let n = 2; taken.has(id); n++) id = `${VOICE_CLIP_ID}-${n}`;
  const sourceFileId = voice.source.kind === "file" ? voice.source.fileId : null;
  return {
    ...timeline,
    durationSeconds: duration,
    video: timeline.video.map(stretch),
    audio: [
      ...timeline.audio.map((clip) => (clip.role === "music" ? stretch(clip) : clip)),
      { id, start: LEAD_SECONDS, end: round2(Math.min(duration, LEAD_SECONDS + spoken)), source: voice.source, in: 0, role: "voice", volume: 1, fadeIn: 0, fadeOut: 0.05, loop: false },
    ],
    captions: words.length ? pages(words, Math.min(duration, round2(LEAD_SECONDS + spoken + 0.3))) : timeline.captions,
    transcript: words.length ? { language: voice.language, words, sourceFileId } : timeline.transcript,
  };
}
