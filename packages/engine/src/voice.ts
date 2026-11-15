import { createHash } from "node:crypto";
import { compositionSchema, MAX_COMPOSITION_SECONDS, type Composition } from "../../contracts/src/index.js";
import type { EngineDeps } from "./access.js";
import { FILES_TABLE, fileKey, filesOf } from "./files.js";
import { selectOne, type Row } from "./store.js";
import { defaultVoices, layVoiceover, speakFirst, speaksAlready, spreadWords, type SpokenWord, type VoiceSpec } from "./voice-providers.js";

/**
 * Voiceovers made during production. A timeline that nobody speaks in (no voice clip, no presenter video with its own
 * sound) gets its script read aloud before it is rendered:
 *
 *   1. the persona's own voices, in their fallback order (persona_voices, priority 1 first), when a persona was chosen
 *      and its consent is live;
 *   2. otherwise, or when each of those fails, the deployment's stock voice for the script's language (Microsoft
 *      Text to Speech first; see docs/product/microsoft-tts.md).
 *
 * The voice becomes an ordinary `voice` draft file of the project, made once per script and voice and reused after
 * that. The render job's snapshot gets the voice clip, word timings and captions timed to them; the saved edit is
 * left as the person made it. When no voice can be made here, the render is still queued and the job tells the
 * render worker what to say, so the worker can make it with its own keys (workers/reel-render).
 */
export const PERSONA_VOICES_TABLE = "persona_voices";

/** What a render worker should say when the job arrives without a voice. */
export interface NarrationHint {
  text: string;
  language: string;
}

/** Someone already speaks: a voice clip, or a main-picture video (presenter render or camera take) playing its sound. */
export const hasVoice = (composition: Composition, itemHasMedia: boolean) => speaksAlready(composition, itemHasMedia);

/** The words to say: the item's script, else the captions on screen. */
export function narrationText(item: Row, composition: Composition): string {
  const script = typeof item.script === "string" ? item.script.replace(/\s+/g, " ").trim() : "";
  return script || composition.captions.map((cue) => cue.text).join(" ").replace(/\s+/g, " ").trim();
}

/** The persona's voices, default first, when its consent is live. A voice without a fallback priority is never picked here. */
export async function personaVoiceSpecs(deps: EngineDeps, orgId: string, personaId: string | null): Promise<VoiceSpec[]> {
  if (!personaId) return [];
  const persona = await selectOne(deps.store, "personas", { id: personaId, org_id: orgId }).catch(() => null);
  if (!persona?.consent_id) return [];
  const consent = await selectOne(deps.store, "likeness_consents", { id: persona.consent_id, org_id: orgId }).catch(() => null);
  if (!consent || consent.revoked_at) return [];
  const rows = await deps.store.select(PERSONA_VOICES_TABLE, { org_id: orgId, persona_id: personaId }, { limit: 20 }).catch(() => [] as Row[]);
  return rows
    .filter((row) => typeof row.priority === "number" && typeof row.provider_voice_id === "string" && row.provider_voice_id)
    .sort((a, b) => a.priority - b.priority)
    .flatMap((row): VoiceSpec[] =>
      row.provider === "cartesia" || row.provider === "elevenlabs" || row.provider === "fal"
        ? [{ provider: row.provider, model: row.model ?? null, voice: row.provider_voice_id, name: `${persona.name} · ${row.name}`.slice(0, 120), settings: row.settings ?? {} }]
        : [],
    );
}

const specKey = (spec: VoiceSpec, text: string, language: string) =>
  createHash("sha256").update(JSON.stringify([spec.provider, spec.model, spec.voice, spec.settings ?? {}, language, text])).digest("hex");

/** The timeline with the voice laid in from the start, captions paged on its words, and the length to fit it. */
export function withVoiceover(composition: Composition, voice: { fileId: string; durationSeconds: number; words: SpokenWord[]; language: string }): Composition {
  return compositionSchema.parse(layVoiceover(composition, { source: { kind: "file", fileId: voice.fileId }, durationSeconds: voice.durationSeconds, words: voice.words, language: voice.language }, MAX_COMPOSITION_SECONDS));
}

export interface Narrated {
  composition: Composition;
  /** Set when the timeline still has no voice, so the render worker makes it. */
  hint: NarrationHint | null;
  /** One line for the audit trail. */
  outcome: string;
}

/** Makes (or reuses) the voiceover for a render job's snapshot. Never throws for a speech service's failure. */
export async function narrate(deps: EngineDeps, input: { orgId: string; projectId: string; item: Row; composition: Composition; personaId: string | null }): Promise<Narrated> {
  const { orgId, projectId, item, composition } = input;
  if (hasVoice(composition, Boolean(item.media_asset_id))) return { composition, hint: null, outcome: "" };
  const text = narrationText(item, composition);
  if (!text) return { composition, hint: null, outcome: "Nothing to read aloud: the script is empty." };
  const language = typeof item.language === "string" && item.language ? item.language : "en";
  const hint = { text, language };
  const persona = await personaVoiceSpecs(deps, orgId, input.personaId);
  const specs = [...persona, ...defaultVoices(deps.config.voice, language)];
  if (!specs.length) return { composition, hint, outcome: "No voice service is connected to the engine; the render worker reads the script." };
  const files = filesOf(deps);
  if (!files.configured) return { composition, hint, outcome: "File storage isn’t connected, so the engine can’t keep a voice; the render worker reads the script." };

  // The same script in the same voice is made once.
  const voiceFiles = await deps.store.select(FILES_TABLE, { org_id: orgId, project_id: projectId, item_id: item.id, kind: "voice", state: "ready" }, { order: ["created_at", "desc"], limit: 50 });
  for (const spec of specs) {
    const cached = voiceFiles.find((file) => file.meta?.narration === specKey(spec, text, language) && Number(file.duration_seconds) > 0);
    if (cached) {
      const durationSeconds = Number(cached.duration_seconds);
      return { composition: withVoiceover(composition, { fileId: cached.id, durationSeconds, words: spreadWords(text, durationSeconds), language }), hint: null, outcome: `Voiceover: ${spec.name} (reused)` };
    }
  }

  const { speech, failures } = await speakFirst(deps.fetch, deps.config.voice, specs, text, language);
  if (!speech) {
    console.warn(JSON.stringify({ level: "warn", event: "voiceover_failed", failures }));
    return { composition, hint, outcome: `The engine could not make the voice (${failures.join("; ").slice(0, 300)}); the render worker reads the script.` };
  }
  const sha256 = createHash("sha256").update(speech.bytes).digest("hex");
  const key = fileKey(orgId, projectId, sha256, speech.mime);
  if (!(await files.head(key))) await files.put(key, speech.bytes, speech.mime);
  const name = `${String(item.title ?? "Video").slice(0, 100)} voiceover`;
  const previous = await deps.store.select(FILES_TABLE, { org_id: orgId, project_id: projectId, item_id: item.id, name }, { order: ["version", "desc"], limit: 1 });
  const now = deps.now().toISOString();
  const file = await deps.store.insert(FILES_TABLE, {
    id: crypto.randomUUID(),
    org_id: orgId,
    project_id: projectId,
    item_id: item.id,
    kind: "voice",
    name,
    mime: speech.mime,
    bytes: speech.bytes.byteLength,
    sha256,
    duration_seconds: speech.durationSeconds,
    meta: { provider: speech.spec.provider, model: speech.spec.model, voice: speech.spec.voice, voiceName: speech.spec.name, language, generated: true, narration: specKey(speech.spec, text, language) },
    state: "ready",
    version: (previous[0]?.version ?? 0) + 1,
    storage_key: key,
    created_by: "Faceful voiceover",
    actor_id: "system:voiceover",
    created_at: now,
    updated_at: now,
  });
  const fellBack = persona.length > 0 && !persona.some((spec) => spec === speech.spec);
  return {
    composition: withVoiceover(composition, { fileId: file.id, durationSeconds: speech.durationSeconds, words: speech.words, language }),
    hint: null,
    outcome: `Voiceover: ${speech.spec.name}${fellBack ? ` (the persona’s own voices failed: ${failures.join("; ").slice(0, 200)})` : ""}`,
  };
}

/**
 * A persona video made from a timeline shows the persona: when nothing is on the main picture, the chosen look's photo
 * (else the straight-on still from the persona's scan, else any look) is copied into the project and held for the
 * whole video. Only for a persona whose consent is live. Null when there is nothing to add.
 */
export async function withPersonaStill(
  deps: EngineDeps,
  input: { orgId: string; projectId: string; item: Row; composition: Composition; personaId: string | null; lookId: string | null },
): Promise<Composition | null> {
  const { orgId, projectId, item, composition } = input;
  if (!input.personaId || composition.video.some((clip) => clip.layer === 0)) return null;
  const files = filesOf(deps);
  if (!files.configured) return null;
  const persona = await selectOne(deps.store, "personas", { id: input.personaId, org_id: orgId }).catch(() => null);
  const consent = persona?.consent_id ? await selectOne(deps.store, "likeness_consents", { id: persona.consent_id, org_id: orgId }).catch(() => null) : null;
  if (!persona || !consent || consent.revoked_at) return null;
  const looks = await deps.store.select("persona_looks", { org_id: orgId, persona_id: persona.id }, { limit: 20 }).catch(() => [] as Row[]);
  const chosen = input.lookId ? looks.find((look) => look.id === input.lookId && look.image_key) : null;
  const key: unknown = chosen?.image_key ?? consent.stills?.center ?? looks.find((look) => look.image_key)?.image_key;
  if (typeof key !== "string" || !key) return null;
  const response = await deps.fetch(await files.downloadUrl(key, 600)).catch(() => null);
  if (!response?.ok) return null;
  const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const type = mime === "image/png" || mime === "image/webp" ? mime : "image/jpeg";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024) return null;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const stored = fileKey(orgId, projectId, sha256, type);
  if (!(await files.head(stored))) await files.put(stored, bytes, type);
  const name = `${String(persona.name).slice(0, 80)} photo`;
  const existing = (await deps.store.select(FILES_TABLE, { org_id: orgId, project_id: projectId, sha256, state: "ready" }, { limit: 1 }))[0];
  const now = deps.now().toISOString();
  const file =
    existing ??
    (await deps.store.insert(FILES_TABLE, {
      id: crypto.randomUUID(),
      org_id: orgId,
      project_id: projectId,
      item_id: item.id,
      kind: "image",
      name,
      mime: type,
      bytes: bytes.byteLength,
      sha256,
      duration_seconds: null,
      meta: { personaId: persona.id, lookId: chosen?.id ?? null, source: "persona" },
      state: "ready",
      version: 1,
      storage_key: stored,
      created_by: "Faceful",
      actor_id: "system:persona",
      created_at: now,
      updated_at: now,
    }));
  return compositionSchema.parse({
    ...composition,
    video: [
      {
        id: composition.video.some((clip) => clip.id === "presenter") ? "persona-photo" : "presenter",
        start: 0,
        end: composition.durationSeconds,
        source: { kind: "file", fileId: file.id },
        media: "image",
        in: 0,
        layer: 0,
        layout: "full",
        volume: 0,
        syncOffsetFrames: 0,
        transitionIn: { kind: "cut", duration: 0 },
        transitionOut: { kind: "cut", duration: 0 },
      },
      ...composition.video,
    ],
  });
}
