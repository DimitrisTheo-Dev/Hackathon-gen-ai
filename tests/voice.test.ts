import { test } from "node:test";
import assert from "node:assert/strict";
import { getComposition, saveComposition } from "../packages/engine/src/composition";
import { listFiles } from "../packages/engine/src/files";
import { queueRender } from "../packages/engine/src/reel-render";
import { RENDERS_TABLE } from "../packages/engine/src/reel-render";
import { azureSsml, azureTtsUrl, defaultVoices, mp3Duration, spreadWords, voiceKeysFrom } from "../packages/engine/src/voice-providers";
import { WORKER_TOKEN, engine, key, seed } from "./reel-support";

/** A real MPEG-1 layer III stream: `frames` frames of 128 kbit/s at 44.1 kHz (417 bytes each, 1152 samples). */
function mp3(frames: number) {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  const bytes = new Uint8Array(417 * frames);
  for (let index = 0; index < frames; index++) bytes.set(frame, index * 417);
  return bytes;
}
const AZURE = { AZURE_SPEECH_KEY: "k".repeat(32), AZURE_SPEECH_REGION: "westeurope" };

test("an MP3's length is read from its frames, and words are spread over it in order", () => {
  assert.equal(mp3Duration(mp3(100)), Math.round((100 * 1152 * 1000) / 44100) / 1000);
  // An ID3 tag in front is skipped; anything that is not an MP3 has no length.
  const tagged = new Uint8Array(20 + 417 * 10);
  tagged.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10]);
  tagged.set(mp3(10), 20);
  assert.equal(mp3Duration(tagged), Math.round((10 * 1152 * 1000) / 44100) / 1000);
  assert.equal(mp3Duration(new TextEncoder().encode("<html>not audio</html>")), 0);
  const words = spreadWords("Myth: you need hours. Fact: five focused minutes, done.", 6);
  assert.equal(words.length, 9);
  for (let index = 1; index < words.length; index++) assert.ok(words[index].start >= words[index - 1].end);
  assert.ok(words[0].start > 0 && words.at(-1)!.end <= 6);
  // A sentence end leaves a longer pause than the gap between two words.
  assert.ok(words[4].start - words[3].end > words[2].start - words[1].end);
});

test("Microsoft Text to Speech is used with a key and a region or endpoint, and gets a voice per language", () => {
  assert.equal(voiceKeysFrom({ AZURE_SPEECH_KEY: "k" }).azure, null, "a key alone does not say where to send it");
  const regional = voiceKeysFrom(AZURE).azure!;
  assert.equal(azureTtsUrl(regional), "https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1");
  const custom = voiceKeysFrom({ AZURE_SPEECH_KEY: "k", AZURE_SPEECH_ENDPOINT: "https://faceful-speech.cognitiveservices.azure.com/" }).azure!;
  assert.equal(azureTtsUrl(custom), "https://faceful-speech.cognitiveservices.azure.com/tts/cognitiveservices/v1");
  assert.equal(defaultVoices(voiceKeysFrom(AZURE), "el")[0].voice, "el-GR-AthinaNeural");
  assert.equal(defaultVoices(voiceKeysFrom(AZURE), "en")[0].voice, "en-US-AvaMultilingualNeural");
  assert.equal(defaultVoices(voiceKeysFrom({ ...AZURE, AZURE_TTS_VOICE: "en-GB-OllieMultilingualNeural", AZURE_TTS_VOICE_EL: "el-GR-NestorasNeural" }), "el")[0].voice, "el-GR-NestorasNeural");
  assert.deepEqual(defaultVoices(voiceKeysFrom({}), "en"), []);
  // Script text is escaped; a voice from another locale is told the script's language.
  const ssml = azureSsml("Fish & <chips>", "en-US-AvaMultilingualNeural", "de");
  assert.match(ssml, /Fish &amp; &lt;chips&gt;/);
  assert.match(ssml, /<lang xml:lang="de-DE">/);
  assert.doesNotMatch(azureSsml("Γεια", "el-GR-AthinaNeural", "el"), /<lang/);
});

async function savedTimeline(env: ReturnType<typeof engine>) {
  const seeded = await seed(env);
  const document = await getComposition(env.deps, seeded.ctx, seeded.item.id);
  // No presenter video: captions and a title card only, the way New project saves a "no face" video.
  const composition = { ...document.composition, video: [] };
  const saved = await saveComposition(env.deps, seeded.ctx, { contentId: seeded.item.id, expectedRevision: 0, composition, operationKey: key() });
  return { ...seeded, saved };
}
function speechService(env: ReturnType<typeof engine>, answer: (url: string) => Response) {
  const calls: Array<{ url: string; body: string }> = [];
  env.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    return answer(url);
  }) as typeof fetch;
  return calls;
}
const audio = () => new Response(mp3(400), { headers: { "content-type": "audio/mpeg" } });
const snapshot = async (env: ReturnType<typeof engine>, id: string) => (await env.deps.store.select(RENDERS_TABLE, { id }))[0].composition;

test("a render of a timeline nobody speaks in gets the script read aloud, kept as a voice file and reused", async () => {
  const env = engine(AZURE);
  const { ctx, campaign, item, saved } = await savedTimeline(env);
  const calls = speechService(env, audio);
  const render = await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1");
  assert.match(calls[0].body, /en-US-AvaMultilingualNeural/);
  assert.match(calls[0].body, /first scan is at week six/);
  const job = await snapshot(env, render.id);
  const voice = job.audio.find((clip: { role: string }) => clip.role === "voice");
  assert.ok(voice, "the job has a voice clip");
  assert.equal(voice.source.kind, "file");
  const seconds = mp3Duration(mp3(400));
  assert.ok(job.durationSeconds >= seconds, "the video is long enough for the voice");
  assert.equal(job.transcript.sourceFileId, voice.source.fileId);
  assert.ok(job.captions.length > 3 && job.captions.at(-1).end <= job.durationSeconds);
  const files = await listFiles(env.deps, ctx, campaign.id);
  const file = files.find((entry) => entry.id === voice.source.fileId)!;
  assert.equal(file.kind, "voice");
  assert.equal(file.mime, "audio/mpeg");
  // The saved edit is unchanged; only the job carries the voice.
  assert.equal((await getComposition(env.deps, ctx, item.id)).composition.audio.length, 0);
  // The same script in the same voice is not made twice.
  const again = await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key() });
  assert.equal(calls.length, 1);
  assert.equal((await snapshot(env, again.id)).audio.find((clip: { role: string }) => clip.role === "voice").source.fileId, voice.source.fileId);
  // The worker gets nothing to read: the voice is already there.
  const claim = await (await env.call("/v1/worker/reel/claim", WORKER_TOKEN, { workerId: "vps-1" })).json();
  assert.equal(claim.job.narration, null);
  assert.ok(claim.job.files[voice.source.fileId], "the voice file comes with a signed link");
});

test("a persona reads with its own voices in order, and a stock voice steps in when they all fail", async () => {
  const env = engine({ ...AZURE, CARTESIA_API_KEY: "c".repeat(32) });
  const { ctx, item, saved } = await savedTimeline(env);
  const now = env.deps.now().toISOString();
  await env.deps.store.insert("likeness_consents", { id: "consent-1", org_id: ctx.org.id, revoked_at: null, stills: {}, created_at: now });
  await env.deps.store.insert("personas", { id: "8a6b1c2d-0000-4000-8000-000000000001", org_id: ctx.org.id, name: "Dr Tan", consent_id: "consent-1", created_at: now });
  for (const [priority, id] of [[2, "voice-b"], [1, "voice-a"]] as const)
    await env.deps.store.insert("persona_voices", { id, org_id: ctx.org.id, persona_id: "8a6b1c2d-0000-4000-8000-000000000001", name: `Clone ${priority}`, provider: "cartesia", model: "sonic-3", provider_voice_id: id, settings: {}, priority, created_at: now });
  // Cartesia answers for the default voice.
  let calls = speechService(env, (url) => (url.includes("cartesia") ? audio() : new Response("no", { status: 500 })));
  let render = await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key(), personaId: "8a6b1c2d-0000-4000-8000-000000000001" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /"id":"voice-a"/, "priority 1 first");
  assert.ok((await snapshot(env, render.id)).audio.some((clip: { role: string }) => clip.role === "voice"));
  // Every persona voice fails: the render still gets a voice, from Microsoft.
  await env.deps.store.update("persona_voices", { org_id: ctx.org.id }, { settings: { speed: 1.1 } });
  calls = speechService(env, (url) => (url.includes("cartesia") ? new Response("out of credit", { status: 402 }) : audio()));
  render = await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key(), personaId: "8a6b1c2d-0000-4000-8000-000000000001" });
  assert.deepEqual(calls.map((call) => new URL(call.url).hostname), ["api.cartesia.ai", "api.cartesia.ai", "westeurope.tts.speech.microsoft.com"]);
  assert.ok((await snapshot(env, render.id)).audio.some((clip: { role: string }) => clip.role === "voice"));
  // A withdrawn consent: the persona's voices are not used at all.
  await env.deps.store.update("likeness_consents", { id: "consent-1" }, { revoked_at: now });
  await env.deps.store.update("persona_voices", { org_id: ctx.org.id }, { settings: { speed: 1.2 } });
  calls = speechService(env, audio);
  render = await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key(), personaId: "8a6b1c2d-0000-4000-8000-000000000001" });
  assert.deepEqual(calls, [], "the stock voice made above is reused; no persona voice is asked for");
  assert.ok((await snapshot(env, render.id)).audio.some((clip: { role: string }) => clip.role === "voice"));
});

test("without a speech service the render is still queued, and the worker is told what to read", async () => {
  const env = engine();
  const { ctx, item, saved } = await savedTimeline(env);
  const calls = speechService(env, audio);
  const render = await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key() });
  assert.equal(render.state, "queued");
  assert.equal(calls.length, 0);
  const claim = await (await env.call("/v1/worker/reel/claim", WORKER_TOKEN, { workerId: "vps-1" })).json();
  assert.match(claim.job.narration.text, /^Your first scan is at week six\./);
  assert.equal(claim.job.narration.language, "en");
});

test("a timeline that already has a voice is rendered as it is", async () => {
  const env = engine(AZURE);
  const { ctx, item } = await seed(env);
  const document = await getComposition(env.deps, ctx, item.id);
  const take = await env.deps.store.insert("project_files", { id: "take-1", org_id: ctx.org.id, project_id: item.campaignId, item_id: item.id, kind: "voice", name: "Voice take", mime: "audio/webm", bytes: 10, sha256: "a".repeat(64), duration_seconds: 8, meta: {}, state: "ready", version: 1, storage_key: "k", created_by: "me", actor_id: "u1", created_at: env.deps.now().toISOString(), updated_at: env.deps.now().toISOString() });
  const composition = { ...document.composition, video: [], audio: [{ id: "voice", start: 0, end: 5, source: { kind: "file" as const, fileId: take.id }, in: 0, role: "voice" as const, volume: 1, fadeIn: 0, fadeOut: 0, loop: false }] };
  const saved = await saveComposition(env.deps, ctx, { contentId: item.id, expectedRevision: 0, composition, operationKey: key() });
  const calls = speechService(env, audio);
  const render = await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key() });
  assert.equal(calls.length, 0);
  assert.deepEqual((await snapshot(env, render.id)).audio, composition.audio);
});

test("a persona video with nothing on screen shows the chosen look's photo, kept in the project", async () => {
  const env = engine(AZURE);
  const { ctx, item, saved, campaign } = await savedTimeline(env);
  const now = env.deps.now().toISOString();
  const personaId = "8a6b1c2d-0000-4000-8000-000000000002";
  await env.deps.store.insert("likeness_consents", { id: "consent-2", org_id: ctx.org.id, revoked_at: null, stills: { center: `orgs/${ctx.org.id}/likeness/center.jpg` }, created_at: now });
  await env.deps.store.insert("personas", { id: personaId, org_id: ctx.org.id, name: "Dr Tan", consent_id: "consent-2", created_at: now });
  await env.deps.store.insert("persona_looks", { id: "look-1", org_id: ctx.org.id, persona_id: personaId, name: "Clinic", image_key: `orgs/${ctx.org.id}/personas/${personaId}/look.jpg`, position: 0, created_at: now });
  const photo = new Uint8Array(900).fill(3);
  await env.files.put(`orgs/${ctx.org.id}/personas/${personaId}/look.jpg`, photo, "image/jpeg");
  const asked: string[] = [];
  env.deps.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url.startsWith("https://files.test/")) return new Response(photo, { headers: { "content-type": "image/jpeg" } });
    return audio();
  }) as typeof fetch;
  const render = await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key(), personaId, lookId: "look-1" });
  const job = await snapshot(env, render.id);
  assert.equal(job.video[0].media, "image");
  assert.equal(job.video[0].layer, 0);
  assert.equal(job.video[0].end, job.durationSeconds, "the photo holds for the whole video, voice included");
  const file = (await listFiles(env.deps, ctx, campaign.id)).find((entry) => entry.id === job.video[0].source.fileId)!;
  assert.equal(file.kind, "image");
  assert.ok(asked.some((url) => url.includes("look.jpg")), "the chosen look, not the scan still");
  // Without a live consent nothing of the person is used.
  await env.deps.store.update("likeness_consents", { id: "consent-2" }, { revoked_at: now });
  const later = await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key(), personaId, lookId: "look-1" });
  assert.equal((await snapshot(env, later.id)).video.length, 0);
});
