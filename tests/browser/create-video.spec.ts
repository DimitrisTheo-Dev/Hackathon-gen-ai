import { test, expect, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * New project → Script → Create: no preview step, Create starts the video, and the video comes back with a voice.
 * Runs from tests/browser/create.config.ts, against the in-memory engine (the test plays the render worker) or, live,
 * against a real engine and render worker (the test downloads the MP4 and checks its audio with ffprobe).
 */
const mode = process.env.FACEFUL_CREATE_E2E;
test.skip(!mode, 'Run with tests/browser/create.config.ts');

const SUPABASE = 'https://hgsgvdujzatfhsjoojll.supabase.co';
/** The in-memory engine's stand-in reel worker credential (support/memory-engine.ts). */
const REEL_WORKER_TOKEN = 'e2e-reel-worker-token-not-a-real-credential-0001';
const BRIEF = 'Three productivity myths people believe every day, and the facts that replace them, for busy parents.';

/** A stand-in session the e2e engines accept. Live, it names the one real user that engine was started for. */
function session(id: string) {
  const user = { id, aud: 'authenticated', role: 'authenticated', email: `${id}@e2e.test`, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `${[{ alg: 'none', typ: 'JWT' }, { iss: 'faceful-e2e', sub: id, email: user.email, exp, aud: 'authenticated', role: 'authenticated' }].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')}.e2e`;
  return { token, user, stored: { access_token: token, refresh_token: 'e2e-not-a-credential', token_type: 'bearer', expires_in: 3600, expires_at: exp, user } };
}
async function signIn(page: Page) {
  const who = session(process.env.FACEFUL_CREATE_E2E_USER ?? `e2e-${crypto.randomUUID()}`);
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ['sb-hgsgvdujzatfhsjoojll-auth-token', JSON.stringify(who.stored)]);
  await page.route(`${SUPABASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/auth/v1/user') return route.fulfill({ json: who.user });
    if (url.pathname === '/rest/v1/castroom_director_entries') return route.fulfill(route.request().method() === 'POST' ? { status: 201, json: [] } : { json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  return who;
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('Script → Create makes the video, and the video has a voice', async ({ page }) => {
  await signIn(page);
  // Home, even for a person whose studio would open on a project with a job running.
  await page.goto('/studio/?view=home');
  await page.getByRole('button', { name: /^Create a video/ }).click();
  await page.locator('#np-brief').fill(BRIEF);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Who appears in the video?' })).toBeVisible();
  await page.getByRole('radio', { name: /No face/ }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'How should it be made?' })).toBeVisible();
  await page.getByRole('button', { name: 'Write the script' }).click();
  await expect(page.locator('.np-beat-text').first()).not.toHaveValue('', { timeout: 60_000 });

  // Script is the last step: four steps on the rail, no Preview, and its action is Create.
  await expect(page.locator('.np-rail li')).toHaveCount(4);
  await expect(page.locator('.np-rail')).not.toContainText('Preview');
  await expect(page.getByRole('button', { name: 'See the preview' })).toHaveCount(0);
  await page.locator('.np-foot').getByRole('button', { name: 'Create', exact: true }).click();

  // The video studio opens on the render that Create queued.
  await expect(page.locator('.np')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/Queued — waiting for a render worker|Rendering version|MP4 ready/).first()).toBeVisible({ timeout: 30_000 });
  const item = new URL(page.url()).searchParams.get('item');
  expect(item, 'the studio shows the new video').toBeTruthy();

  if (mode === 'memory') {
    // Act as the render worker: the job already carries the voiceover the engine made, timed into captions.
    const worker = (path: string, data: unknown) => page.request.post(`/v1/worker/reel${path}`, { headers: { Authorization: `Bearer ${REEL_WORKER_TOKEN}` }, data });
    const { job } = await (await worker('/claim', { workerId: 'e2e-worker' })).json();
    expect(job?.itemId).toBe(item);
    const voice = job.composition.audio.find((clip: { role: string }) => clip.role === 'voice');
    expect(voice, 'the job has a voice clip').toBeTruthy();
    expect(job.narration).toBeNull();
    expect(job.composition.transcript.words.length).toBeGreaterThan(5);
    expect(job.composition.captions.at(-1).end).toBeLessThanOrEqual(job.composition.durationSeconds);
    const take = await page.request.get(job.files[voice.source.fileId].url);
    const mp3 = new Uint8Array(await take.body());
    expect([mp3[0], mp3[1] & 0xe0]).toEqual([0xff, 0xe0]);
    // Deliver an MP4 the way a worker does: checksum-locked upload, then complete.
    const output = new Uint8Array(4096).fill(9);
    const digest = sha256(output);
    const upload = await (await worker(`/${job.id}/upload-url`, { workerId: 'e2e-worker', sha256: digest, bytes: output.byteLength })).json();
    expect((await page.request.put(upload.url, { headers: upload.headers, data: Buffer.from(output) })).ok()).toBe(true);
    expect((await worker(`/${job.id}/complete`, { workerId: 'e2e-worker', sha256: digest, bytes: output.byteLength, durationSeconds: job.composition.durationSeconds })).ok()).toBe(true);
  }

  // The finished MP4 is offered right where the person is.
  await expect(page.getByText(/MP4 ready · version/)).toBeVisible({ timeout: mode === 'live' ? 14 * 60_000 : 30_000 });
  if (mode === 'live') {
    const href = await page.locator('.render-card').getByRole('link', { name: 'Download' }).getAttribute('href');
    const video = await page.request.get(href!);
    expect(video.ok()).toBe(true);
    const dir = join('test-results', 'create-video');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'created.mp4');
    writeFileSync(file, await video.body());
    // A real audio track, and not a silent one: the voiceover is in the file.
    const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration', '-of', 'json', file], { encoding: 'utf8' })).streams as Array<{ codec_type: string; codec_name: string; duration: string }>;
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    expect(audio?.codec_name).toBe('aac');
    expect(Number(audio?.duration)).toBeGreaterThan(5);
    const loudness = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(loudness)?.[1] ?? -91);
    expect(mean, 'the audio track is not silence').toBeGreaterThan(-45);
    writeFileSync(join(dir, 'ffprobe.json'), JSON.stringify({ streams, meanVolumeDb: mean }, null, 2));
  }
});
