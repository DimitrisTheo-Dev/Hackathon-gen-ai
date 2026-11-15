/**
 * Turns a rendered OpenMontage template run (for example templates/face/talking-tip) into a Faceful reel
 * package: a folder with reel.json and copies of the parts, ready for `faceful-reel.mjs push`.
 *
 *   node --import tsx scripts/reel/from-openmontage.ts <run-dir> <out-dir>
 *
 * What maps onto the studio timeline, part by part:
 *   • presenter segments (props.segments, the lip-synced clips in public/) → main picture clips, muted;
 *   • the processed voice take → the voice track, at the run's mix offset;
 *   • the music bed → the music track, at the gain the run's mix used;
 *   • every placed sound effect (audio_report.sfx) → its own SFX clip;
 *   • the checked word timings → the transcript, and caption pages built from it;
 *   • the brand → accent and background colours, plus a closing card with the name and handle.
 * Runs with no presenter (the no-face templates) draw their pictures inside the Remotion composition, which
 * the studio cannot take apart; their rendered sample.mp4 becomes the one main picture clip, with its sound.
 * Keyword emphasis and the hand-built caption design stay in the template: the studio has one caption style.
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { captionsFromWords, compositionSchema, NO_TRANSITION, type AudioClip, type Composition, type VideoClip } from "../../packages/contracts/src/composition";

interface Word { t: string; s: number; e: number }
interface Beat { id: string; say: string; start: number; end: number; words: Word[] }
interface Segment { name: string; start: number; end: number; from: number; dur: number; clip: string; trim?: number }
interface Props {
  fps: number;
  duration: number;
  lang: string;
  topic: string;
  brand: { name: string; handle?: string; colors?: { accent?: string; shade?: string } };
  cta?: { line?: string };
  beats: Beat[];
  segments?: Segment[];
}
interface AudioReport { mix_offset_ms?: number; music_gain_db?: number; sfx?: Array<[string, number, number]> }
type FileEntry = { key: string; kind: string; name: string; path?: string; text?: string; mime?: string; durationSeconds?: number; meta?: Record<string, string | number | boolean | null> };

const round = (value: number) => Math.round(value * 1000) / 1000;
const exists = (path: string) => stat(path).then(() => true, () => false);
const json = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;

/** Seconds of audio in a PCM WAV file, from its header. */
export function wavSeconds(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= bytes.byteLength; ) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt ") byteRate = view.getUint32(at + 16, true);
    if (tag(at) === "data") return byteRate ? Math.min(size, bytes.byteLength - at - 8) / byteRate : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

/** A media file's length: WAV from its header, anything else through ffprobe when it is installed. */
async function seconds(path: string): Promise<number | null> {
  if (extname(path).toLowerCase() === ".wav") return wavSeconds(new Uint8Array(await readFile(path)));
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { encoding: "utf8" });
  const value = Number.parseFloat(probe.stdout ?? "");
  return probe.status === 0 && Number.isFinite(value) ? value : null;
}

async function firstExisting(...paths: string[]) {
  for (const path of paths) if (await exists(path)) return path;
  return null;
}

/** The template kit's shared sound effects: the nearest `_kit/sfx` above the run. */
async function findSfxDir(runDir: string) {
  for (let dir = resolve(runDir); dir !== dirname(dir); dir = dirname(dir)) if (await exists(join(dir, "_kit", "sfx"))) return join(dir, "_kit", "sfx");
  return null;
}

export async function packageFromOpenMontage(runDir: string, outDir: string) {
  runDir = resolve(runDir);
  const props = await json<Props>(join(runDir, "artifacts", "props.json"));
  const audio = (await exists(join(runDir, "artifacts", "audio_report.json"))) ? await json<AudioReport>(join(runDir, "artifacts", "audio_report.json")) : {};
  const spec = (await exists(join(runDir, "spec.json"))) ? await json<Record<string, any>>(join(runDir, "spec.json")) : {};
  const template = String(spec.template ?? basename(runDir));
  const duration = round(props.duration);
  const files: FileEntry[] = [];
  const copies: Array<[string, string]> = [];
  /** Registers a media file once and returns its "@key" reference. */
  const media = async (key: string, kind: string, name: string, source: string, meta: FileEntry["meta"] = {}) => {
    if (!files.some((file) => file.key === key)) {
      const path = `media/${key}${extname(source).toLowerCase()}`;
      const length = await seconds(source);
      files.push({ key, kind, name, path, ...(length ? { durationSeconds: round(length) } : {}), meta: { source: "openmontage", template, ...meta } });
      copies.push([source, join(outDir, path)]);
    }
    return { ref: `@${key}`, seconds: files.find((file) => file.key === key)!.durationSeconds ?? null };
  };

  const words = props.beats.flatMap((beat) => beat.words).map((word) => ({ t: word.t.slice(0, 60), start: round(word.s), end: round(Math.max(word.e, word.s)) }));
  const script = props.beats.map((beat) => beat.say.trim()).join(" ");
  files.push({ key: "script", kind: "script", name: "Script", mime: "text/markdown", text: `# ${props.topic}\n\n${props.beats.map((beat) => `- **${beat.id}** (${beat.start.toFixed(2)}–${beat.end.toFixed(2)} s): ${beat.say.trim()}`).join("\n")}\n` });
  files.push({ key: "transcript", kind: "transcript", name: "Word timings", mime: "application/json", text: JSON.stringify({ language: props.lang, words, beats: props.beats.map(({ id, start, end, say }) => ({ id, start, end, say })) }, null, 1) });
  if (Object.keys(spec).length) files.push({ key: "spec", kind: "other", name: "OpenMontage spec", mime: "application/json", text: JSON.stringify(spec, null, 1) });

  const video: VideoClip[] = [];
  const audioClips: AudioClip[] = [];
  const segments = (props.segments ?? []).filter((segment) => segment.clip);
  const presenter = segments.length > 0;
  if (presenter) {
    for (const segment of segments) {
      const source = join(runDir, "public", segment.clip);
      if (!(await exists(source))) throw new Error(`Presenter clip ${segment.clip} is missing from ${runDir}/public.`);
      const { ref } = await media(`clip_${segment.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40), "avatar_clip", `Presenter ${segment.name}`, source, { segment: segment.name });
      const start = round(segment.from / props.fps);
      const end = round(Math.min(duration, (segment.from + segment.dur) / props.fps));
      if (end > start) video.push({ id: `presenter-${segment.name}`.slice(0, 40), start, end, source: { kind: "file", fileId: ref }, media: "video", in: round((segment.trim ?? 0) / props.fps), layer: 0, layout: "full", volume: 0, syncOffsetFrames: 0, transitionIn: NO_TRANSITION, transitionOut: NO_TRANSITION });
    }
    const voice = await firstExisting(...["voice_enh.wav", "voice_host.wav", "voice.wav"].map((name) => join(runDir, "assets", "audio", name)));
    if (voice) {
      const { ref, seconds: length } = await media("voice", "voice", "Voice take", voice, { voice: spec.voice?.name ?? null, engine: spec.voice?.engine ?? null });
      const start = round((audio.mix_offset_ms ?? 0) / 1000);
      audioClips.push({ id: "voice", start, end: round(Math.min(duration, start + (length ?? duration))), source: { kind: "file", fileId: ref }, in: 0, role: "voice", volume: 1, fadeIn: 0, fadeOut: 0, loop: false });
    }
    const bed = await firstExisting(join(runDir, "assets", "music", "bed.mp3"), join(runDir, "assets", "audio", "music_48k.wav"));
    if (bed) {
      const { ref, seconds: length } = await media("music", "music", "Music bed", bed, { prompt: typeof spec.music?.prompt === "string" ? spec.music.prompt.slice(0, 2000) : null });
      const volume = Math.min(1, Math.round(10 ** ((audio.music_gain_db ?? -14) / 20) * 100) / 100);
      audioClips.push({ id: "music", start: 0, end: duration, source: { kind: "file", fileId: ref }, in: 0, role: "music", volume, fadeIn: 0.3, fadeOut: 1.2, loop: length !== null && length < duration });
    }
    const sfxDir = await findSfxDir(runDir);
    for (const [index, [sound, at, gain]] of (audio.sfx ?? []).entries()) {
      const source = sfxDir ? join(sfxDir, `${sound}.wav`) : null;
      if (!source || !(await exists(source))) continue;
      const { ref, seconds: length } = await media(`sfx_${sound}`, "sfx", `SFX ${sound}`, source);
      const start = round(Math.max(0, at));
      const end = round(Math.min(duration, start + (length ?? 0.3)));
      if (end > start) audioClips.push({ id: `sfx-${index + 1}`, start, end, source: { kind: "file", fileId: ref }, in: 0, role: "sfx", volume: Math.min(1, gain), fadeIn: 0, fadeOut: 0, loop: false });
    }
  } else {
    const sample = join(runDir, "sample.mp4");
    if (!(await exists(sample))) throw new Error(`${runDir} has no presenter segments and no sample.mp4.`);
    const { ref } = await media("visuals", "video", "Rendered visuals (with sound)", sample, { note: "Drawn inside the Remotion composition; edit the template to change it." });
    video.push({ id: "visuals", start: 0, end: duration, source: { kind: "file", fileId: ref }, media: "video", in: 0, layer: 0, layout: "full", volume: 1, syncOffsetFrames: 0, transitionIn: NO_TRANSITION, transitionOut: NO_TRANSITION });
  }

  const lastSpoken = props.beats.at(-1)?.end ?? duration;
  const closing = round(Math.min(Math.max(lastSpoken, 0), Math.max(0, duration - 1)));
  const composition: Composition = compositionSchema.parse({
    version: 2,
    fps: [24, 25, 30].includes(props.fps) ? props.fps : 25,
    durationSeconds: duration,
    video,
    audio: audioClips,
    // The sample already shows its brand lockup and burned-in words; only a presenter run gets studio ones.
    cards: presenter ? [{ id: "brand", start: closing, end: duration, kind: "cta", title: props.brand.name.slice(0, 80), subtitle: (props.brand.handle ?? "").slice(0, 140), imageFileId: null }] : [],
    captions: presenter ? captionsFromWords(words, 4, closing) : [],
    transcript: { language: props.lang, words, sourceFileId: "@transcript" },
    style: {
      accent: /^#[0-9a-f]{6}$/i.test(props.brand.colors?.accent ?? "") ? props.brand.colors!.accent : "#5F6C66",
      background: /^#[0-9a-f]{6}$/i.test(props.brand.colors?.shade ?? "") ? props.brand.colors!.shade : "#111214",
      captionPosition: "bottom",
      captionSize: "large",
      // The run's mix sets the bed's level without ducking; keep it that way.
      duckMusic: false,
    },
    labels: { aiAvatar: presenter, disclaimer: "" },
  });
  const manifest = {
    format: "faceful-reel/1",
    source: { tool: "openmontage", template, run: basename(runDir) },
    project: { title: props.topic.slice(0, 120), language: props.lang, brand: { name: props.brand.name, description: `Imported from the OpenMontage template "${template}".` } },
    item: { title: props.topic.slice(0, 120), script },
    files,
    composition,
  };
  await mkdir(join(outDir, "media"), { recursive: true });
  for (const [from, to] of copies) await copyFile(from, to);
  await writeFile(join(outDir, "reel.json"), JSON.stringify(manifest, null, 1) + "\n");
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [runDir, outDir] = process.argv.slice(2);
  if (!runDir || !outDir) {
    console.log("Usage: node --import tsx scripts/reel/from-openmontage.ts <run-dir> <out-dir>");
    process.exit(2);
  }
  const manifest = await packageFromOpenMontage(runDir, resolve(outDir));
  const { video, audio, cards, captions } = manifest.composition;
  console.log(`Wrote ${join(resolve(outDir), "reel.json")}: ${manifest.files.length} files; ${video.length} video, ${audio.length} audio, ${cards.length} cards, ${captions.length} captions over ${manifest.composition.durationSeconds}s.`);
}
