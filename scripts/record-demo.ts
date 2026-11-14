/**
 * Record the demo-video footage from production, one 1920×1080 clip per beat, with a visible cursor and
 * human-paced pointer movement and typing.
 *
 *   node --env-file=.env.local --import tsx scripts/record-demo.ts                 # all nine clips, checkout last
 *   node --env-file=.env.local --import tsx scripts/record-demo.ts 3 4             # only clips 3 and 4
 *   node --env-file=.env.local --import tsx scripts/record-demo.ts --no-checkout   # clip 9 records the billing page only
 *   DEMO_ORIGIN=http://127.0.0.1:6377 node --env-file=.env.local --import tsx scripts/record-demo.ts 0   # the /pitch page (opt-in)
 *
 * Needs DEMO_USER_EMAIL / DEMO_USER_PASSWORD (a password-only demo account, see scripts/demo-seed.ts),
 * SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY. DEMO_ORIGIN overrides https://faceful.vercel.app.
 * Writes demo-footage/NN-<beat>.webm and demo-footage/manifest.json (gitignored folder).
 *
 * What it changes in the demo workspace, on purpose: clip 3 sends one request to the director (it answers
 * that AI writing is not connected), clip 4 saves one exact script edit as a new version of a sample draft,
 * clip 9 starts a Stripe sandbox subscription with the test card. It never creates or reveals agent tokens,
 * never shows environment values, and never approves a schedule.
 */
import { chromium, type Browser, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ORIGIN = (process.env.DEMO_ORIGIN ?? "https://faceful.vercel.app").replace(/\/$/, "");
const STORAGE_KEY = "sb-hgsgvdujzatfhsjoojll-auth-token";
const OUT = resolve("demo-footage");
const TMP = join(OUT, ".raw");
const SIZE = { width: 1920, height: 1080 };
const args = process.argv.slice(2);
const only = args.filter((arg) => /^\d+$/.test(arg)).map(Number);
const allowCheckout = !args.includes("--no-checkout");

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

// ───────────────────────── Session ─────────────────────────

async function signIn() {
  const { SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, DEMO_USER_EMAIL, DEMO_USER_PASSWORD } = process.env;
  if (!SUPABASE_URL || !VITE_SUPABASE_PUBLISHABLE_KEY || !DEMO_USER_EMAIL || !DEMO_USER_PASSWORD)
    throw new Error("Set SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, DEMO_USER_EMAIL and DEMO_USER_PASSWORD (run with --env-file=.env.local).");
  const supabase = createClient(SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.auth.signInWithPassword({ email: DEMO_USER_EMAIL, password: DEMO_USER_PASSWORD });
  if (error || !data.session) throw new Error(`Demo sign-in failed: ${error?.message ?? "no session"}`);
  return JSON.stringify(data.session);
}

// ───────────────────────── Visible cursor ─────────────────────────

/**
 * Runs in every page of the context: an arrow that follows the real mouse, with a ripple on press.
 * A plain string, not a function: tsx rewrites functions with helpers that do not exist in the page.
 * Built with DOM and CSSOM calls only, so strict pages (Stripe Checkout's CSP and Trusted Types) allow it.
 */
const CURSOR_SCRIPT = `(() => {
  if (window.top !== window || window.__demoCursor) return;
  window.__demoCursor = true;
  const mount = () => {
    const ns = "http://www.w3.org/2000/svg";
    const root = document.createElement("div");
    const ripple = document.createElement("div");
    const svg = document.createElementNS(ns, "svg");
    const path = document.createElementNS(ns, "path");
    svg.setAttribute("width", "30"); svg.setAttribute("height", "30"); svg.setAttribute("viewBox", "0 0 24 24");
    path.setAttribute("d", "M4.5 2.8 19 13.1l-6.6 1.1 3.9 7.2-2.9 1.5-3.9-7.3-4.9 4.6Z");
    path.setAttribute("fill", "#ffffff"); path.setAttribute("stroke", "#1d1d1b"); path.setAttribute("stroke-width", "1.5"); path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    Object.assign(root.style, { position: "fixed", inset: "auto", left: "0", top: "0", width: "1px", height: "1px", margin: "0", padding: "0", border: "0", background: "transparent", overflow: "visible", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-200px, -200px)", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.28))" });
    Object.assign(ripple.style, { position: "absolute", left: "-15px", top: "-15px", width: "34px", height: "34px", boxSizing: "border-box", borderRadius: "50%", background: "rgba(255,176,0,.38)", border: "2px solid rgba(255,176,0,.9)", opacity: "0", transform: "scale(.5)", transition: "opacity 260ms ease-out, transform 360ms cubic-bezier(.23,1,.32,1)" });
    Object.assign(svg.style, { position: "absolute", left: "-4px", top: "-2px", transition: "transform 120ms cubic-bezier(.23,1,.32,1)" });
    root.append(ripple, svg);
    (document.body || document.documentElement).append(root);
    // In the top layer (a manual popover), so it stays above modal dialogs; raised again whenever a dialog opens.
    const raise = () => { try { if (root.matches(":popover-open")) root.hidePopover(); root.showPopover(); } catch (error) { /* no popover support */ } };
    root.setAttribute("popover", "manual");
    raise();
    new MutationObserver((records) => { if (records.some((r) => r.target !== root && r.target.nodeName === "DIALOG")) raise(); }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["open"] });
    addEventListener("mousemove", (e) => { root.style.transform = "translate(" + e.clientX + "px, " + e.clientY + "px)"; }, { capture: true, passive: true });
    addEventListener("mousedown", () => { ripple.style.opacity = "1"; ripple.style.transform = "scale(1)"; svg.style.transform = "scale(.88)"; }, { capture: true, passive: true });
    addEventListener("mouseup", () => { ripple.style.opacity = "0"; ripple.style.transform = "scale(1.5)"; svg.style.transform = "none"; setTimeout(() => { ripple.style.transform = "scale(.5)"; }, 380); }, { capture: true, passive: true });
    // If the app ever replaces the body, put the cursor back.
    new MutationObserver(() => { if (!root.isConnected) { (document.body || document.documentElement).append(root); raise(); } }).observe(document.documentElement, { childList: true });
  };
  if (document.body) mount(); else addEventListener("DOMContentLoaded", mount, { once: true });
})();`;

// ───────────────────────── Human pacing ─────────────────────────

const pointer = new WeakMap<Page, { x: number; y: number }>();
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Glide the real mouse to (x, y) along an eased path, at roughly a person's speed. */
async function glide(page: Page, x: number, y: number, duration?: number) {
  const from = pointer.get(page) ?? { x: SIZE.width * 0.62, y: SIZE.height * 0.7 };
  const distance = Math.hypot(x - from.x, y - from.y);
  const ms = duration ?? Math.min(1100, Math.max(320, distance * 0.9));
  const steps = Math.max(10, Math.round(ms / 16));
  // A slight arc reads as a hand, not a robot.
  const bend = (Math.random() - 0.5) * Math.min(80, distance * 0.12);
  for (let i = 1; i <= steps; i++) {
    const t = easeInOut(i / steps);
    const arc = Math.sin(Math.PI * t) * bend;
    await page.mouse.move(from.x + (x - from.x) * t + arc, from.y + (y - from.y) * t - arc * 0.4);
    await sleep(ms / steps);
  }
  pointer.set(page, { x, y });
}

async function pointAt(page: Page, target: Locator, pause = 350) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("target has no box");
  await glide(page, box.x + box.width / 2 + jitter(-4, 4), box.y + box.height / 2 + jitter(-2, 2));
  await sleep(pause);
  return box;
}

async function press(page: Page) {
  await page.mouse.down();
  await sleep(jitter(70, 110));
  await page.mouse.up();
}

async function clickOn(page: Page, target: Locator, pause = 450) {
  await pointAt(page, target, jitter(140, 240));
  await press(page);
  await sleep(pause);
}

/** Type like a person: uneven key timing, a breath after words and punctuation. */
async function typeHuman(page: Page, text: string, speed = 1) {
  for (const char of text) {
    await page.keyboard.type(char);
    const pauseAfter = /[.,:;!?—]/.test(char) ? jitter(160, 260) : char === " " ? jitter(55, 120) : jitter(28, 75);
    await sleep(pauseAfter / speed);
  }
}

/** Scroll with the wheel in small steps, like a trackpad. */
async function scrollBy(page: Page, deltaY: number, ms = 1200) {
  const steps = Math.max(8, Math.round(ms / 30));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, deltaY / steps);
    await sleep(ms / steps);
  }
}

/** Waits up to `timeout` for the first match to be visible (isVisible() itself never waits). */
const visible = async (target: Locator, timeout = 1500) => target.first().waitFor({ state: "visible", timeout }).then(() => true, () => false);

// ───────────────────────── Clips ─────────────────────────

type Clip = { n: number; name: string; title: string; signedIn: boolean; run: (page: Page) => Promise<string | void> };

async function openStudio(page: Page) {
  await page.goto(`${ORIGIN}/studio/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("navigation", { name: "Studio" }).waitFor({ timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await sleep(1200);
}

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Studio" });

const clips: Clip[] = [
  {
    // Opt-in (`record-demo.ts 0`): the one-minute /pitch page as a fallback video. Point DEMO_ORIGIN at a server
    // that serves /pitch (for example the Vite dev server) until it is deployed.
    n: 0, name: "pitch", title: "The one-minute /pitch page, start to end card", signedIn: false,
    async run(page) {
      await page.goto(`${ORIGIN}/pitch?autoplay=0`, { waitUntil: "networkidle" });
      await page.locator(".pitch").waitFor({ timeout: 30_000 });
      await sleep(600);
      await page.keyboard.press("r"); // restart from 0:00; a key press also hides the control strip
      await page.locator(".pitch.is-ended").waitFor({ timeout: 75_000 });
      await sleep(1500);
      return `Label: ${await page.getByTestId("presenter-label").textContent()}`;
    },
  },
  {
    n: 1, name: "landing", title: "Landing hero and the studio demo", signedIn: false,
    async run(page) {
      await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
      await sleep(2600);
      const cta = page.getByRole("link", { name: /start creating|get started|try/i }).first();
      if (await visible(cta)) await pointAt(page, cta, 1200);
      const demo = page.locator("figure.landing-demo");
      await glide(page, SIZE.width * 0.5, SIZE.height * 0.72, 700);
      const box = await demo.boundingBox();
      if (box) await scrollBy(page, Math.max(0, box.y - 90), 1800);
      await sleep(400);
      // One full loop of the illustrated studio (about ten seconds).
      await glide(page, SIZE.width * 0.83, SIZE.height * 0.86, 900);
      await sleep(10_600);
      await scrollBy(page, 760, 2200);
      await sleep(1800);
    },
  },
  {
    n: 2, name: "sign-in", title: "Sign-in card (not submitted)", signedIn: false,
    async run(page) {
      await page.goto(`${ORIGIN}/studio/`, { waitUntil: "networkidle" });
      const email = page.locator('input[type="email"]');
      await email.waitFor({ timeout: 30_000 });
      await sleep(1600);
      await pointAt(page, page.getByRole("button", { name: /Continue with Google/ }), 900);
      await clickOn(page, email, 300);
      await typeHuman(page, "eleni@example.com");
      await sleep(500);
      const submit = page.locator("form").getByRole("button").filter({ hasText: /code|continue|email/i }).last();
      if (await visible(submit)) await pointAt(page, submit, 1600);
      await sleep(900);
      return "Typed a placeholder address (eleni@example.com); the form was not submitted.";
    },
  },
  {
    n: 3, name: "studio-home", title: "Composer, preference pills, honest reply and the Claude Code hand-off", signedIn: true,
    async run(page) {
      await openStudio(page);
      await page.getByRole("button", { name: "Create", exact: true }).click().catch(() => undefined);
      const field = page.locator("textarea").first();
      await field.waitFor();
      await sleep(1200);
      for (const [label, value] of [["Format", "reel"], ["Length", "15"], ["Language", "el"]] as const) {
        const select = page.getByRole("combobox", { name: label });
        await pointAt(page, select, 380);
        await press(page);
        await page.keyboard.press("Escape").catch(() => undefined);
        await select.selectOption(value);
        await sleep(520);
      }
      await clickOn(page, field, 300);
      await typeHuman(page, "A friendly Greek presenter introduces BeWell’s Monday morning sessions, ready for Monday at 09:00.");
      await sleep(700);
      const send = page.getByRole("button", { name: /Prepare action plan|Send/ }).first();
      if (await visible(send)) await clickOn(page, send, 300);
      else await page.keyboard.press("Enter");
      const handoff = page.getByText("Your own Claude Code can write this");
      await handoff.waitFor({ timeout: 30_000 });
      await sleep(1600);
      await pointAt(page, page.getByText(/AI writing isn’t connected/).last(), 1800);
      await pointAt(page, handoff, 1200);
      const copy = page.getByRole("button", { name: "Copy prompt" }).last();
      if (await visible(copy)) await pointAt(page, copy, 1800);
      await sleep(1200);
    },
  },
  {
    n: 4, name: "bewell-edit", title: "BeWell sample canvas, an exact edit, the diff, Apply, the new version", signedIn: true,
    async run(page) {
      await openStudio(page);
      await clickOn(page, sidebar(page).getByRole("button", { name: /A week of BeWell/ }), 1600);
      await glide(page, SIZE.width * 0.45, SIZE.height * 0.45, 800);
      await sleep(900);
      await clickOn(page, page.getByRole("button", { name: /^Edit Find your next moment/ }), 1600);
      const version = await page.getByText(/Version \d+ · Draft/).first().textContent().catch(() => null);
      const chat = page.getByPlaceholder(/Ask for a change/).first();
      const input = (await visible(chat, 4000)) ? chat : page.locator("textarea").last();
      await clickOn(page, input, 300);
      await typeHuman(page, "Set script: Find your next moment at BeWell. Plan your day, save the sessions you love, and meet us Monday morning.", 1.4);
      await sleep(600);
      await page.keyboard.press("Enter");
      const apply = page.getByRole("button", { name: "Apply changes" }).last();
      await apply.waitFor({ timeout: 30_000 });
      await sleep(1400);
      await pointAt(page, page.locator("ins, del, .diff, [class*='diff']").first(), 1500).catch(() => undefined);
      await clickOn(page, apply, 400);
      const next = Number(version?.match(/\d+/)?.[0] ?? 0) + 1;
      await page.getByText(next > 1 ? `Version ${next} · Draft` : /Saved as version \d+/).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
      await sleep(1800);
      const after = await page.getByText(/Version \d+ · Draft/).first().textContent().catch(() => null);
      await clickOn(page, page.getByRole("button", { name: "Details", exact: true }), 900);
      const versions = page.getByRole("button", { name: "Versions", exact: true });
      if (await visible(versions, 4000)) {
        await clickOn(page, versions, 1500);
        await glide(page, SIZE.width * 0.86, SIZE.height * 0.62, 900);
        await scrollBy(page, 360, 1400);
        await sleep(1800);
      }
      return `Draft “Find your next moment”: ${version ?? "?"} → ${after ?? "?"}. Each run adds one version to this sample draft.`;
    },
  },
  {
    n: 5, name: "brand-kit", title: "Brand kit, the add-source sheet (cancelled)", signedIn: true,
    async run(page) {
      await openStudio(page);
      await clickOn(page, sidebar(page).getByRole("button", { name: "Brand kit", exact: true }), 1800);
      await glide(page, SIZE.width * 0.55, SIZE.height * 0.55, 800);
      await scrollBy(page, 520, 2200);
      await sleep(900);
      await scrollBy(page, 620, 2200);
      await sleep(700);
      const add = page.getByRole("button", { name: "Add source" }).first();
      await clickOn(page, add, 1400);
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 8000 });
      const first = dialog.locator("input, textarea").first();
      if (await visible(first)) await pointAt(page, first, 1200);
      await clickOn(page, dialog.getByRole("button", { name: "Cancel" }), 1200);
      await scrollBy(page, -1100, 2000);
      await sleep(900);
    },
  },
  {
    n: 6, name: "schedule-review", title: "Schedule week view and the review checklist", signedIn: true,
    async run(page) {
      await openStudio(page);
      await clickOn(page, sidebar(page).getByRole("button", { name: "Schedule", exact: true }), 2000);
      await glide(page, SIZE.width * 0.5, SIZE.height * 0.42, 900);
      await sleep(1600);
      const review = page.getByRole("button", { name: "Review schedule" }).first();
      await clickOn(page, review, 1800);
      const dialog = page.getByRole("dialog");
      if (await visible(dialog, 6000)) {
        const box = await dialog.first().boundingBox();
        if (box) { await glide(page, box.x + box.width * 0.4, box.y + box.height * 0.35, 900); await sleep(1600); await glide(page, box.x + box.width * 0.45, box.y + box.height * 0.65, 900); }
        await sleep(2600);
        await page.keyboard.press("Escape");
      }
      await sleep(1000);
    },
  },
  {
    n: 7, name: "agents", title: "Agents: the client grid and the Claude Code steps (no token created)", signedIn: true,
    async run(page) {
      await openStudio(page);
      await clickOn(page, sidebar(page).getByRole("button", { name: /^Agents/ }), 2000);
      for (const name of [/^Codex/, /^Cursor/, /^Any MCP client/]) {
        const card = page.getByRole("button", { name }).first();
        if (await visible(card)) await pointAt(page, card, 450);
      }
      await clickOn(page, page.getByRole("button", { name: /^Claude Code/ }).first(), 1800);
      await glide(page, SIZE.width * 0.55, SIZE.height * 0.6, 900);
      await scrollBy(page, 420, 1800);
      await sleep(2200);
      await scrollBy(page, -420, 1400);
      await sleep(900);
      return "Only browsed the steps; no token was created, revoked or revealed.";
    },
  },
  {
    n: 8, name: "agent-project", title: "The Greek Reel project a connected Claude Code agent created", signedIn: true,
    async run(page) {
      await openStudio(page);
      await clickOn(page, sidebar(page).getByRole("button", { name: /Monday Morning Instagram Reel/ }).first(), 1800);
      await glide(page, SIZE.width * 0.42, SIZE.height * 0.42, 900);
      await sleep(1600);
      const activity = page.getByRole("button", { name: "Campaign activity" });
      if (await visible(activity)) {
        await clickOn(page, activity, 2200);
        await glide(page, SIZE.width * 0.86, SIZE.height * 0.4, 900);
        await sleep(2600);
        await page.keyboard.press("Escape");
        await sleep(600);
      }
      const draft = page.getByRole("button", { name: /^Edit A —/ }).first();
      if (await visible(draft)) {
        await clickOn(page, draft, 2000);
        await glide(page, SIZE.width * 0.86, SIZE.height * 0.5, 900);
        await sleep(2400);
      }
    },
  },
  {
    n: 9, name: "billing-checkout", title: "Billing → Stripe sandbox Checkout with the test card → plan active, credits added", signedIn: true,
    async run(page) {
      await openStudio(page);
      await clickOn(page, sidebar(page).getByRole("button", { name: "Billing", exact: true }), 600);
      await page.locator(".billing-number").waitFor({ timeout: 30_000 });
      await sleep(1600);
      const before = Number(await page.locator(".billing-number").first().textContent());
      await pointAt(page, page.locator(".billing-number").first(), 1200);
      const upgrade = page.getByRole("button", { name: /Upgrade with Stripe test checkout/ });
      if (!allowCheckout || !(await visible(upgrade, 3000))) {
        await glide(page, SIZE.width * 0.5, SIZE.height * 0.6, 900);
        await sleep(3000);
        return !allowCheckout ? `Billing page only (--no-checkout). Credits shown: ${before}.` : `Checkout unavailable (already subscribed or not configured); recorded the billing page only. Credits shown: ${before}.`;
      }
      await clickOn(page, upgrade, 300);
      await page.waitForURL(/checkout\.stripe\.com/, { timeout: 45_000 });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await sleep(2200);
      const email = page.locator("#email");
      if ((await visible(email)) && (await email.isEditable().catch(() => false)) && !(await email.inputValue().catch(() => ""))) {
        await clickOn(page, email, 200);
        await typeHuman(page, "eleni@example.com", 1.6);
      }
      // The payment-method rows are custom controls: a real click on the visible "Card" label opens the card fields.
      const cardNumber = page.locator("#cardNumber");
      if (!(await visible(cardNumber, 1500))) {
        const label = page.getByText("Card", { exact: true }).first();
        const box = await label.boundingBox();
        if (!box) throw new Error("Stripe Checkout: no Card row found");
        await glide(page, box.x + box.width / 2, box.y + box.height / 2);
        await sleep(200);
        await press(page);
      }
      await cardNumber.waitFor({ timeout: 15_000 });
      await sleep(600);
      await clickOn(page, cardNumber, 200);
      await typeHuman(page, "4242424242424242", 1.3);
      await clickOn(page, page.locator("#cardExpiry"), 150);
      await typeHuman(page, "1234", 1.3);
      await clickOn(page, page.locator("#cardCvc"), 150);
      await typeHuman(page, "123", 1.3);
      const name = page.locator("#billingName");
      if (await visible(name)) { await clickOn(page, name, 150); await typeHuman(page, "Eleni Demo", 1.6); }
      const zip = page.locator("#billingPostalCode");
      if (await visible(zip, 500)) { await clickOn(page, zip, 150); await typeHuman(page, "10557", 1.6); }
      await sleep(700);
      const pay = page.locator('button[type="submit"]').last();
      await clickOn(page, pay, 300);
      await page.waitForURL((url) => url.href.startsWith(`${ORIGIN}/studio`), { timeout: 90_000 });
      await glide(page, SIZE.width * 0.55, SIZE.height * 0.45, 900);
      // The plan changes only when Stripe's signed webhook arrives; wait for the page to show it.
      const deadline = Date.now() + 60_000;
      let after = before;
      while (Date.now() < deadline) {
        const shown = await page.locator(".billing-number").first().textContent({ timeout: 2000 }).catch(() => null);
        after = Number(shown ?? before);
        if (after > before && (await visible(page.getByText(/^Active$/), 500))) break;
        await sleep(1000);
      }
      await pointAt(page, page.locator(".billing-number").first(), 1600);
      const plan = page.locator(".ob-plan-status").first();
      if (await visible(plan)) await pointAt(page, plan, 1800);
      await sleep(2000);
      return after > before ? `Checkout completed with the test card; credits ${before} → ${after}, plan active.` : `Checkout returned but the webhook had not updated the plan within 60s (credits still ${after}). Re-record or trim.`;
    },
  },
];

// ───────────────────────── Runner ─────────────────────────

type Result = { clip: string; file: string | null; seconds: number; usableFrom: number; ok: boolean; note: string };

async function record(browser: Browser, clip: Clip): Promise<Result> {
  const file = join(OUT, `${String(clip.n).padStart(2, "0")}-${clip.name}.webm`);
  const session = clip.signedIn ? await signIn() : null;
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, recordVideo: { dir: TMP, size: SIZE }, locale: "en-GB", timezoneId: "Europe/Athens", colorScheme: "light", reducedMotion: "no-preference" });
  await context.addInitScript(CURSOR_SCRIPT);
  if (session) await context.addInitScript(([origin, key, value]) => { try { if (location.origin === origin) localStorage.setItem(key, value); } catch { /* storage blocked */ } }, [ORIGIN, STORAGE_KEY, session] as const);
  const page = await context.newPage();
  const started = Date.now();
  let usableFrom = 0;
  page.once("load", () => { usableFrom = (Date.now() - started) / 1000; });
  let note = "";
  let ok = true;
  try {
    note = (await clip.run(page)) ?? "";
  } catch (error) {
    ok = false;
    note = `Failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
  const seconds = (Date.now() - started) / 1000;
  const video = page.video();
  await context.close();
  if (video) {
    await video.saveAs(file);
    await video.delete().catch(() => undefined);
  }
  return { clip: `${String(clip.n).padStart(2, "0")} ${clip.title}`, file: video ? file : null, seconds: Math.round(seconds * 10) / 10, usableFrom: Math.round((usableFrom + 0.4) * 10) / 10, ok, note };
}

await mkdir(TMP, { recursive: true });
const browser = await chromium.launch();
const results: Result[] = [];
try {
  for (const clip of clips.filter((entry) => (entry.n === 0 ? only.includes(0) : only.length === 0 || only.includes(entry.n)))) {
    process.stdout.write(`Recording ${String(clip.n).padStart(2, "0")}-${clip.name}… `);
    const result = await record(browser, clip);
    results.push(result);
    console.log(`${result.ok ? "ok" : "FAILED"} · ${result.seconds}s${result.note ? ` · ${result.note}` : ""}`);
  }
} finally {
  await browser.close();
  await rm(TMP, { recursive: true, force: true });
}
// Merge into the existing manifest, so recording one clip again keeps the others' entries.
const manifestPath = join(OUT, "manifest.json");
const previous = await readFile(manifestPath, "utf8").then((text) => JSON.parse(text) as { clips?: Result[] }, () => ({ clips: [] as Result[] }));
const merged = [...(previous.clips ?? []).filter((entry) => !results.some((result) => result.clip.slice(0, 2) === entry.clip.slice(0, 2))), ...results].sort((a, b) => a.clip.localeCompare(b.clip));
await writeFile(manifestPath, `${JSON.stringify({ origin: ORIGIN, updatedAt: new Date().toISOString(), size: SIZE, clips: merged }, null, 2)}\n`);
console.log(`\nWrote ${results.filter((result) => result.file).length} clips and manifest.json to ${OUT}`);
