/**
 * Record the /pitch motion (or the /pitch-doctor variant) as H.264 video, frame by frame.
 *
 * Unlike scripts/record-demo.ts (a real-time screen recording), this never drops a frame: the page's clock
 * (performance.now and requestAnimationFrame) and every CSS transition and animation are stepped by hand,
 * one output frame at a time, and each frame is a full screenshot. A range can therefore also be recorded
 * faster or slower than real time with no frame blending: the page simply advances further per frame.
 *
 *   node --import tsx scripts/record-pitch-motion.ts --out studio.mp4 --segments 8:38:30
 *   node --import tsx scripts/record-pitch-motion.ts --out cut.mp4 --segments 8:12.8:4.84,16:20.7:3.12
 *   node --import tsx scripts/record-pitch-motion.ts --stills ./frames --at 9,19.6,27.2,33
 *
 *   --route     page to record (default /pitch-doctor; /pitch records the original)
 *   --origin    server that serves it (default http://127.0.0.1:6391, a Vite dev server)
 *   --segments  from:to:seconds, comma separated: a page-time range and how long it lasts in the output.
 *               Ranges must go forward in page time and start at 1.5 or later.
 *   --fps       output frame rate (default 60)
 *   --offset    where the first segment starts on the edit's timeline, in seconds (default 0); only used to
 *               round segment boundaries to the same frames the edit will use
 *   --progress  keep the page's thin progress bar (hidden by default, like the control strip)
 *   --clip      ask the page for its presenter clip (?clip=1) and fail if it falls back to the drawing. Every <video>
 *               on the page is paused and moved to the output's own time, so a clip plays at its natural
 *               speed even inside a range recorded faster or slower, and starts at its first frame
 *   --clip-start    where in the clip the first frame sits, in seconds (default 0)
 *   --clip-restart  segments (1-based, comma separated) at whose first frame the clip starts again from --clip-start
 *   --stills    write single PNG frames at the page times given by --at instead of a video
 *
 * The recording shows no cursor, no control strip and no browser chrome. Needs ffmpeg on the PATH.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => { const at = args.indexOf(`--${name}`); return at >= 0 && args[at + 1] ? args[at + 1] : fallback; };

const ORIGIN = option("origin", "http://127.0.0.1:6391").replace(/\/$/, "");
const ROUTE = option("route", "/pitch-doctor");
const FPS = Number(option("fps", "60"));
const OFFSET = Number(option("offset", "0"));
const SIZE = { width: 1920, height: 1080 };
/**
 * The page is opened paused here and played from here, a second before the first frame (6.5 at the latest), so
 * the first cue after it (the pull-back at 8.0) is crossed live. Set in main() once the frames are known.
 */
let LEAD_IN = 6.5;
/** The longest step the page ever sees, in page seconds: one frame of a 60 Hz display. */
const MAX_STEP = 1 / 60;

type Segment = { from: number; to: number; out: number };
const segments: Segment[] = option("segments", "8:38:30").split(",").map((part) => {
  const [from, to, out] = part.split(":").map(Number);
  if (![from, to, out].every(Number.isFinite) || to <= from || out <= 0) throw new Error(`Bad segment "${part}": use from:to:seconds`);
  return { from, to, out };
});

/**
 * Runs before the page's own scripts. Until `enable()` everything passes through to the browser. After it,
 * performance.now and requestAnimationFrame answer from a clock that only `stepTo()` moves, and every
 * animation and transition in the document is held paused and moved by the same amount.
 * A plain string, not a function: tsx rewrites functions with helpers that do not exist in the page.
 */
const VIRTUAL_TIME = `(() => {
  if (window.top !== window || window.__vt) return;
  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  const state = { on: false, base: 0, now: 0, next: 1, queue: new Map(), times: new Map(), seeks: 0, late: 0 };
  performance.now = () => (state.on ? state.now : realNow());
  window.requestAnimationFrame = (callback) => {
    if (!state.on) return realRaf(callback);
    const id = 1e9 + state.next++;
    state.queue.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => { if (!state.queue.delete(id)) realCancel(id); };

  const channel = new MessageChannel();
  let wake = null;
  channel.port1.onmessage = () => { const done = wake; wake = null; if (done) done(); };
  const macrotask = () => new Promise((done) => { wake = done; channel.port2.postMessage(0); });

  // Hold every animation where the virtual clock says it is. New ones start at zero, finished ones are let go.
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
    const callbacks = [...state.queue.values()];
    state.queue.clear();
    for (const callback of callbacks) callback(now);
    // React commits in a microtask and runs effects in later tasks; give them room, then pick up new transitions.
    for (let i = 0; i < 6; i++) await macrotask();
    sync(0);
  };

  // Every video shows the frame for \`seconds\` of its own time (looping), paused, and is painted before we return.
  const syncVideos = (seconds) => Promise.all([...document.querySelectorAll("video")].map((video) => new Promise((done) => {
    try { video.pause(); } catch (error) { /* not ready */ }
    const length = video.duration;
    if (!Number.isFinite(length) || length <= 0) return done();
    const at = Math.min((seconds % length) + 0.001, length - 0.01);
    if (Math.abs(video.currentTime - at) < 1e-6) return done();
    let settled = false;
    const finish = (late) => { if (settled) return; settled = true; if (late) state.late++; done(); };
    const timer = setTimeout(() => finish(true), 1500);
    // After the seek, two real animation frames: the new picture has then been handed to the compositor.
    video.addEventListener("seeked", () => {
      state.seeks++;
      realRaf(() => realRaf(() => { clearTimeout(timer); finish(false); }));
    }, { once: true });
    video.currentTime = at;
  })));

  window.__vt = {
    enable() {
      state.base = state.now = realNow();
      state.on = true;
      for (const animation of document.getAnimations()) {
        state.times.set(animation, Number(animation.currentTime) || 0);
        try { animation.pause(); } catch (error) { /* not ready yet */ }
      }
    },
    /** Advance to \`elapsed\` ms after enable(), in steps no longer than \`maxStep\` ms. */
    async stepTo(elapsed, maxStep, mediaSeconds) {
      let at = state.now - state.base;
      while (elapsed - at > 1e-6) {
        at = Math.min(elapsed, at + maxStep);
        await frame(at);
      }
      if (typeof mediaSeconds === "number") await syncVideos(mediaSeconds);
    },
    videos() {
      return [...document.querySelectorAll("video")].map((video) => ({ src: video.currentSrc, time: Number(video.currentTime.toFixed(3)), paused: video.paused, ready: video.readyState, size: video.videoWidth + "x" + video.videoHeight, opacity: getComputedStyle(video).opacity, seeks: state.seeks, late: state.late }));
    },
    probe() {
      const root = document.querySelector(".pitch");
      const fill = document.querySelector(".pitch-progress-fill");
      const scale = fill ? Number((/scaleX\\(([\\d.]+)\\)/.exec(fill.style.transform) || [])[1]) : NaN;
      return { cue: root ? root.dataset.cue : null, beat: root ? root.dataset.beat : null, idle: root ? root.classList.contains("is-idle") : null, playing: root ? root.dataset.playing : null, progress: scale, animations: state.times.size };
    },
  };
})();`;

/** The page time of every output frame, with segment boundaries rounded on the edit's own timeline. */
function schedule(): { time: number; segment: number }[] {
  const frames: { time: number; segment: number }[] = [];
  let boundary = OFFSET;
  let index = Math.round(boundary * FPS);
  segments.forEach((segment, s) => {
    const end = boundary + segment.out;
    const endIndex = Math.round(end * FPS);
    const speed = (segment.to - segment.from) / segment.out;
    for (; index < endIndex; index++) frames.push({ time: segment.from + (index / FPS - boundary) * speed, segment: s });
    boundary = end;
  });
  return frames;
}

async function main() {
  const stillsDir = flag("stills") ? resolve(option("stills", "stills")) : null;
  const stillTimes = option("at", "").split(",").filter(Boolean).map(Number).sort((a, b) => a - b);
  const out = resolve(option("out", "pitch-motion.mp4"));
  const frames = stillsDir ? stillTimes.map((time) => ({ time, segment: 0 })) : schedule();
  if (!frames.length) throw new Error("Nothing to record.");
  LEAD_IN = Math.min(6.5, frames[0].time - 1);
  if (LEAD_IN < 0.5) throw new Error("Start at 1.5 s of page time or later.");
  frames.forEach((frame, i) => { if (i && frame.time < frames[i - 1].time - 1e-9) throw new Error("Segments must go forward in page time."); });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, locale: "en-GB", timezoneId: "Europe/Athens", colorScheme: "light", reducedMotion: "no-preference" });
  await context.addInitScript(VIRTUAL_TIME);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
  await page.goto(`${ORIGIN}${ROUTE}?autoplay=0&t=${LEAD_IN}${flag("clip") ? "&clip=1" : ""}`, { waitUntil: "networkidle" });
  await page.locator('.pitch[data-presenter="illustration"], .pitch[data-presenter="clip"]').waitFor({ timeout: 30_000 });
  await page.evaluate("document.fonts.ready.then(() => true)");
  if (!flag("progress")) await page.addStyleTag({ content: ".pitch-progress { display: none !important; }" });
  await page.waitForTimeout(800); // first layout, the camera's opening cut, images
  if (flag("clip")) {
    await page.locator('.pitch[data-presenter="clip"]').waitFor({ timeout: 30_000 }).catch(() => { throw new Error("--clip: the page did not load its presenter clip"); });
    await page.waitForTimeout(600); // the clip's fade-in
  }
  const label = await page.getByTestId("presenter-label").textContent();

  await page.evaluate("window.__vt.enable()");
  await page.keyboard.press("Space"); // plays from the lead-in; a key press also hides the control strip
  await page.waitForTimeout(250); // let the page's own play/pause effect run before the first step
  const elapsed = (time: number) => (time - LEAD_IN) * 1000;
  const client = await context.newCDPSession(page);
  const shoot = async () => Buffer.from((await client.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true })).data, "base64");

  let ffmpeg: ReturnType<typeof spawn> | null = null;
  if (stillsDir) await mkdir(stillsDir, { recursive: true });
  else {
    ffmpeg = spawn("ffmpeg", [
      "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-", "-an",
      "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p",
      "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
      "-movflags", "+faststart", out,
    ], { stdio: ["pipe", "inherit", "inherit"] });
  }

  // The clip's own time for every frame: output time since the start, or since the last restart segment began.
  const restarts = new Set(option("clip-restart", "").split(",").filter(Boolean).map((n) => Number(n) - 1));
  let clipZero = 0;
  const started = Date.now();
  for (let i = 0; i < frames.length; i++) {
    const { time, segment } = frames[i];
    if (i > 0 && frames[i - 1].segment !== segment && restarts.has(segment)) clipZero = i;
    const media = flag("clip") ? String(Number(option("clip-start", "0")) + (i - clipZero) / FPS) : "undefined";
    await page.evaluate(`window.__vt.stepTo(${elapsed(time)}, ${MAX_STEP * 1000}, ${media})`);
    const png = await shoot();
    if (stillsDir) await writeFile(join(stillsDir, `t${time.toFixed(2).padStart(5, "0")}.png`), png);
    else if (!ffmpeg!.stdin!.write(png)) await once(ffmpeg!.stdin!, "drain");
    const edge = i === 0 || i === frames.length - 1 || frames[i - 1].segment !== segment || frames[i + 1].segment !== segment;
    if (edge || stillsDir) {
      const probe = await page.evaluate("window.__vt.probe()") as Record<string, unknown>;
      console.log(`frame ${String(i).padStart(4)} · segment ${segment + 1} · page ${time.toFixed(3)} s · ${JSON.stringify(probe)}`);
      if (flag("clip")) console.log(`  video ${JSON.stringify(await page.evaluate("window.__vt.videos()"))}`);
    }
  }
  if (ffmpeg) {
    ffmpeg.stdin!.end();
    const [code] = await once(ffmpeg, "close");
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
  }
  await browser.close();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(stillsDir ? `Wrote ${frames.length} stills to ${stillsDir} in ${seconds}s. Label: ${label}` : `Wrote ${out}: ${frames.length} frames at ${FPS} fps (${(frames.length / FPS).toFixed(3)} s) in ${seconds}s. Label at load: ${label}`);
}

await main();
