/**
 * Record the logo film from /logos (LogoFilm: blue sky, warm fog, the logo, the face that erases the word and
 * winks) as H.264 video, frame by frame, filling the whole 1920x1080 frame. Silent: lay the music on afterwards.
 *
 *   node --import tsx scripts/record-logo-film.ts --out logo.mp4 --fps 60 --seconds 12.9
 *
 *   --origin   server that serves /logos (default http://127.0.0.1:6391, a Vite dev server)
 *   --fps      output frame rate (default 60)
 *   --seconds  how long to record from the press of Play (default 12.9: the film is 9.7 s with the voice off,
 *              then its last frame holds while the second half of the music plays out)
 *   --url      the address shown at the end, in place of the page's placeholder (the page itself is not changed)
 *   --voice    keep the spoken line ("Faceful. Made in an afternoon."); off by default, which makes its hold 2.6 s
 *
 * Like scripts/record-pitch-motion.ts, nothing runs in real time: performance.now, requestAnimationFrame,
 * setTimeout and every CSS transition and animation are moved by hand, one output frame at a time, and each frame
 * is a full screenshot. The film's step timers (setTimeout) therefore fire on the output's own clock.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => { const at = args.indexOf(`--${name}`); return at >= 0 && args[at + 1] ? args[at + 1] : fallback; };

const ORIGIN = option("origin", "http://127.0.0.1:6391").replace(/\/$/, "");
const FPS = Number(option("fps", "60"));
const SECONDS = Number(option("seconds", "12.9"));
const OUT = resolve(option("out", "logo-film.mp4"));
const SIZE = { width: 1920, height: 1080 };
const MAX_STEP = 1000 / 60;

/** A plain string, not a function: tsx rewrites functions with helpers that do not exist in the page. */
const VIRTUAL_TIME = `(() => {
  if (window.top !== window || window.__vt) return;
  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  const state = { on: false, base: 0, now: 0, next: 1, queue: new Map(), times: new Map(), timers: new Map() };
  performance.now = () => (state.on ? state.now : realNow());
  window.requestAnimationFrame = (callback) => {
    if (!state.on) return realRaf(callback);
    const id = 1e9 + state.next++;
    state.queue.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => { if (!state.queue.delete(id)) realCancel(id); };
  window.setTimeout = (callback, ms, ...rest) => {
    if (!state.on || typeof callback !== "function") return realSetTimeout(callback, ms, ...rest);
    const id = 2e9 + state.next++;
    state.timers.set(id, { at: state.now + Math.max(0, Number(ms) || 0), callback, rest });
    return id;
  };
  window.clearTimeout = (id) => { if (!state.timers.delete(id)) realClearTimeout(id); };

  const channel = new MessageChannel();
  let wake = null;
  channel.port1.onmessage = () => { const done = wake; wake = null; if (done) done(); };
  const macrotask = () => new Promise((done) => { wake = done; channel.port2.postMessage(0); });
  const settle = async () => { for (let i = 0; i < 6; i++) await macrotask(); };

  const sync = (dt) => {
    const live = new Set(document.getAnimations());
    for (const animation of state.times.keys()) if (!live.has(animation)) state.times.delete(animation);
    for (const animation of live) {
      const known = state.times.get(animation);
      const at = known === undefined ? 0 : known + dt;
      try {
        animation.pause();
        const end = animation.effect ? animation.effect.getComputedTiming().endTime : Infinity;
        if (Number.isFinite(end) && at >= end) { animation.finish(); state.times.delete(animation); continue; }
        animation.currentTime = at;
        state.times.set(animation, at);
      } catch (error) { state.times.delete(animation); }
    }
  };

  const frame = async (elapsed) => {
    const now = state.base + elapsed;
    const dt = now - state.now;
    state.now = now;
    sync(dt);
    // Timers that are due, in order; one may set another that is also due.
    for (;;) {
      let due = null;
      for (const [id, timer] of state.timers) if (timer.at <= now && (!due || timer.at < due[1].at)) due = [id, timer];
      if (!due) break;
      state.timers.delete(due[0]);
      due[1].callback(...due[1].rest);
      await settle();
    }
    const callbacks = [...state.queue.values()];
    state.queue.clear();
    for (const callback of callbacks) callback(now);
    await settle();
    sync(0);
  };

  window.__vt = {
    enable() {
      state.base = state.now = realNow();
      state.on = true;
      for (const animation of document.getAnimations()) {
        state.times.set(animation, Number(animation.currentTime) || 0);
        try { animation.pause(); } catch (error) { /* not ready yet */ }
      }
    },
    async stepTo(elapsed, maxStep) {
      let at = state.now - state.base;
      while (elapsed - at > 1e-6) {
        at = Math.min(elapsed, at + maxStep);
        await frame(at);
      }
    },
    probe() {
      const film = document.querySelector(".lg-film");
      return film ? [...film.classList].filter((name) => name.startsWith("at-")).join(" ") : null;
    },
  };
})();`;

/** The film's stage, pinned over the whole viewport with its corners squared; its sizes are in cqw, so it scales. */
const FULL_FRAME = `
  html, body { overflow: hidden !important; }
  .lg-film { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
    aspect-ratio: auto !important; border-radius: 0 !important; margin: 0 !important; z-index: 2147483647 !important; }
`;

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, locale: "en-GB", colorScheme: "light", reducedMotion: "no-preference" });
  await context.addInitScript(VIRTUAL_TIME);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
  await page.goto(`${ORIGIN}/logos`, { waitUntil: "networkidle" });
  await page.locator(".lg-film").waitFor({ timeout: 30_000 });
  await page.evaluate("document.fonts.ready.then(() => true)");
  if (!flag("voice")) {
    const toggle = page.locator(".lg-film-controls .lg-button", { hasText: "Voice on" });
    if (await toggle.count()) await toggle.dispatchEvent("click");
  }
  await page.addStyleTag({ content: FULL_FRAME });
  await page.waitForTimeout(500);

  await page.evaluate("window.__vt.enable()");
  await page.locator(".lg-film-controls .lg-button.is-primary").dispatchEvent("click");
  await page.waitForTimeout(300); // React commits the first step (it schedules with MessageChannel, which runs for real)
  // The address is a constant on the page, so React never writes this text again after the film mounts.
  const url = option("url", "");
  if (url) await page.locator(".lg-film-url").evaluate((node, text) => { node.textContent = text; }, url);

  const client = await context.newCDPSession(page);
  const ffmpeg = spawn("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-", "-an",
    "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p",
    "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    "-movflags", "+faststart", OUT,
  ], { stdio: ["pipe", "inherit", "inherit"] });

  const frames = Math.round(SECONDS * FPS);
  let last = "";
  for (let i = 0; i < frames; i++) {
    await page.evaluate(`window.__vt.stepTo(${(i / FPS) * 1000}, ${MAX_STEP})`);
    const png = Buffer.from((await client.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true })).data, "base64");
    if (!ffmpeg.stdin!.write(png)) await once(ffmpeg.stdin!, "drain");
    const steps = await page.evaluate("window.__vt.probe()") as string;
    if (steps !== last) { console.log(`frame ${String(i).padStart(4)} · ${(i / FPS).toFixed(3)} s · ${steps}`); last = steps; }
  }
  ffmpeg.stdin!.end();
  const [code] = await once(ffmpeg, "close");
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
  await browser.close();
  console.log(`Wrote ${OUT}: ${frames} frames at ${FPS} fps (${(frames / FPS).toFixed(3)} s)`);
}

await main();
