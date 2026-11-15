import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../packages/engine/src/config";
import { machinesToken } from "../packages/engine/src/machines";
import { loadConfig as loadRunnerConfig } from "../apps/claude-runner/server";
import { asSaveRecord, corsFor, createLineScanner, homeKeyFor, identify, limitProblem, limitsFrom, machineUsage, mintGatewayToken, parseAllowlist, parseOrigins, parseRunEvent, slugify, usageSince, verifyGatewayToken, WAKE_SQL } from "../apps/machines/src/lib";

const SECRET = "g".repeat(64);
const SUPABASE = "https://project.supabase.co";
const USER = "3f2c1d7e-aaaa-4bbb-8ccc-000000000001";

async function sessionJwt() {
  const { privateKey } = await generateKeyPair("ES256");
  return new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject(USER).setIssuer(`${SUPABASE}/auth/v1`).setAudience("authenticated").setIssuedAt().setExpirationTime("5m").sign(privateKey);
}

test("personal tokens are per user, expire, and can't be forged", async () => {
  const token = await mintGatewayToken(SECRET, "minas", 3600);
  assert.match(token, /^fgw2\.1\.minas\.\d+\.\d+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(await verifyGatewayToken(SECRET, token), "minas");
  assert.equal(await verifyGatewayToken(SECRET, token.replace("minas", "admin")), null);
  assert.equal(await verifyGatewayToken("h".repeat(64), token), null);
  assert.equal(await verifyGatewayToken(undefined, token), null);
  assert.equal(await verifyGatewayToken(SECRET, token, Date.now() + 3_601_000), null, "expired");
  const legacy = `fgw1.minas.${createHmac("sha256", SECRET).update("fgw1:minas").digest("base64url")}`;
  assert.equal(await verifyGatewayToken(SECRET, legacy), null, "the old tokens that never expired are refused");
  await assert.rejects(mintGatewayToken(SECRET, "minas", 31 * 86_400), /30 days/);
  await assert.rejects(mintGatewayToken(SECRET, "Not Valid", 60), /User ids/);

  // Rotation: a new version signs, the old one still verifies until it is removed, which revokes what it signed.
  const rotated = `2:${"n".repeat(64)},1:${SECRET}`;
  assert.equal(await verifyGatewayToken(rotated, token), "minas");
  assert.match(await mintGatewayToken(rotated, "minas", 60), /^fgw2\.2\./);
  assert.equal(await verifyGatewayToken(`2:${"n".repeat(64)}`, token), null);

  const mint = (...args: string[]) => execFileSync(process.execPath, ["apps/machines/mint-token.mjs", ...args], { env: { ...process.env, FACEFUL_GATEWAY_SIGNING_KEY: rotated }, stdio: "pipe" }).toString();
  const cli = mint("minas", "12h");
  assert.equal(await verifyGatewayToken(rotated, cli), "minas");
  const [, version, , issued, expires] = cli.split(".");
  assert.deepEqual([version, Number(expires) - Number(issued)], ["2", 12 * 3600]);
  const [, , , defaultIssued, defaultExpires] = mint("minas").split(".");
  assert.equal(Number(defaultExpires) - Number(defaultIssued), 7 * 86_400, "seven days unless told otherwise");
  assert.throws(() => mint("minas", "45d"), /at most 30d/);
  assert.throws(() => mint("minas", "forever"), /30m, 12h or 7d/);
});

test("the caller is identified from a machines token or a personal token only", async () => {
  const SESSION_KEY = "e".repeat(64);
  const keys = { personal: SECRET, session: `3:${SESSION_KEY}` };
  const engine = loadConfig({ MACHINES_GATEWAY_KEY: `3:${SESSION_KEY}`, MACHINE_ALLOWED_USERS: USER });
  const minted = machinesToken({ config: engine, now: () => new Date() } as never, { principal: { kind: "human", userId: USER.toUpperCase(), email: null } } as never);
  assert.deepEqual(await identify(`Bearer ${minted.token}`, keys), { uid: USER, via: "session" }, "the engine's token, user id lower-cased");
  assert.equal(await identify(`Bearer ${minted.token}`, { personal: SECRET, session: SESSION_KEY }), null, "the key version is part of the token");
  assert.equal(await identify(`Bearer ${minted.token}`, keys, Date.parse(minted.expiresAt) + 1000), null, "ten minutes, then refused");
  assert.equal(await identify(`Bearer ${minted.token}`, { personal: `3:${SESSION_KEY}` }), null, "a session token is not a personal token");
  assert.deepEqual(await identify(`Bearer ${await mintGatewayToken(SECRET, "minas", 60)}`, keys), { uid: "minas", via: "token" });
  assert.equal(await identify(`Bearer ${await mintGatewayToken(SECRET, "minas", 60)}`, { session: keys.session }), null, "no signing key, no personal tokens");
  assert.equal(await identify(`Bearer ${await sessionJwt()}`, keys), null, "a raw Faceful session is never accepted");
  assert.equal(await identify("Bearer fgw1.minas.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", keys), null);
  assert.equal(await identify(null, keys), null);
});

test("CORS answers only listed origins", () => {
  const allowed = parseOrigins("https://faceful.dtheo.dev/, http://127.0.0.1:5173");
  assert.deepEqual(allowed, ["https://faceful.dtheo.dev", "http://127.0.0.1:5173"]);
  assert.equal(corsFor("http://127.0.0.1:5173", allowed)?.["Access-Control-Allow-Origin"], "http://127.0.0.1:5173");
  assert.equal(corsFor("https://evil.example", allowed), null);
  assert.equal(corsFor(null, allowed), null);
});

test("only well-formed saves inside their own project are recorded", () => {
  const save = { key: "projects/demo/autosave.tar.gz", project: "demo", kind: "auto", bytes: 120, files: 3, sha256: "a".repeat(64), savedAt: "2026-11-15T10:00:00.000Z" };
  assert.deepEqual(asSaveRecord(save), save);
  assert.equal(asSaveRecord({ ...save, key: "projects/other/autosave.tar.gz" }), null);
  assert.equal(asSaveRecord({ ...save, project: "../x" }), null);
  assert.equal(asSaveRecord({ ...save, kind: "weird" }), null);
  assert.equal(asSaveRecord({ ...save, bytes: "120" }), null);
  assert.equal(asSaveRecord(null), null);

  assert.deepEqual(parseRunEvent(JSON.stringify({ type: "runner", event: "saved", save })), { kind: "saved", save });
  assert.deepEqual(parseRunEvent(JSON.stringify({ type: "result", subtype: "success", session_id: "11111111-2222-3333-4444-555555555555" })), { kind: "result", sessionId: "11111111-2222-3333-4444-555555555555" });
  assert.equal(parseRunEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: 'I "saved" the "result"' }] } })), null);
  assert.equal(parseRunEvent('{"type":"result","session_id":"nope"}'), null);
  assert.equal(parseRunEvent("not json saved"), null);
});

test("the stream scanner passes bytes through and sees every line once", async () => {
  const encoder = new TextEncoder();
  const text = '{"type":"a"}\n{"type":"b","text":"γειά"}\n{"type":"c"}';
  const bytes = encoder.encode(text);
  const cuts = [5, 20, 27, 28]; // 27 lands inside a two-byte Greek letter
  const chunks = [0, ...cuts].map((start, index) => bytes.slice(start, [...cuts, bytes.length][index]));
  const seen: string[] = [];
  const source = new ReadableStream<Uint8Array>({ start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close(); } });
  const out = new Uint8Array(await new Response(source.pipeThrough(createLineScanner((line) => seen.push(line)))).arrayBuffer());
  assert.deepEqual([...out], [...bytes]);
  assert.deepEqual(seen, text.split("\n"));
  const robust = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode("x\ny\n")); controller.close(); } });
  assert.equal(await new Response(robust.pipeThrough(createLineScanner(() => { throw new Error("boom"); }))).text(), "x\ny\n");
});

test("project ids come from titles", () => {
  assert.equal(slugify("BeWell — Launch Reel #2"), "bewell-launch-reel-2");
  assert.equal(slugify("Ελληνικά"), "");
});

test("only listed accounts get a machine; nothing listed means nobody", () => {
  const allowed = parseAllowlist(` ${USER.toUpperCase()}, live-test ,, Not An Id, `);
  assert.deepEqual([...allowed], [USER, "live-test"]);
  assert.equal(parseAllowlist(undefined).size, 0);
  assert.equal(parseAllowlist("").has(""), false);
});

test("wakes per hour and awake minutes per UTC day are counted from the wake rows", () => {
  const at = (time: string) => `2026-11-15T${time}:00.000Z`;
  const now = Date.parse(at("10:30"));
  const limits = limitsFrom({ MACHINE_WAKES_PER_HOUR: "3", MACHINE_AWAKE_MINUTES_PER_DAY: "60" });
  assert.deepEqual(limits, { wakesPerHour: 3, awakeMinutesPerDay: 60 });
  assert.deepEqual(limitsFrom({ MACHINE_WAKES_PER_HOUR: "0", MACHINE_AWAKE_MINUTES_PER_DAY: "lots" }), { wakesPerHour: 6, awakeMinutesPerDay: 240 });

  // Yesterday's late wake counts only from midnight; an open wake counts until now.
  const usage = machineUsage([
    { started_at: "2026-11-14T23:50:00.000Z", stopped_at: at("00:10") },
    { started_at: at("09:40"), stopped_at: at("09:50") },
    { started_at: at("10:00"), stopped_at: at("10:05") },
    { started_at: at("10:20"), stopped_at: null },
  ], now);
  assert.equal(usage.wakesLastHour, 3);
  assert.equal(usage.awakeMinutesToday, 10 + 10 + 5 + 10);
  assert.equal(limitProblem(usage, limits, now, { waking: false }), null, "an awake machine is not stopped by its wake count");
  const tooOften = limitProblem(usage, limits, now, { waking: true });
  assert.equal(tooOften?.code, "wake_limit");
  assert.equal(tooOften?.retryAfterSeconds, 10 * 60, "the 09:40 wake leaves the hour at 10:40");
  assert.match(tooOften!.message, /3 times in the last hour.*10 min/);

  const spent = machineUsage([{ started_at: at("08:00"), stopped_at: null }], now);
  const daily = limitProblem(spent, limits, now, { waking: false });
  assert.equal(daily?.code, "daily_limit");
  assert.equal(daily?.retryAfterSeconds, 13.5 * 3600);
  assert.match(daily!.message, /60 minutes today.*00:00 UTC, in 13 h 30 min/);
});

test("the wake statements run against schema.sql", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("apps/machines/schema.sql", "utf8"));
  const now = Date.parse("2026-11-15T10:30:00.000Z");
  const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();
  db.prepare(WAKE_SQL.open).run(USER, iso(-60 * 24 * 9));
  db.prepare(WAKE_SQL.close).run(iso(-60 * 24 * 9 + 30), USER);
  db.prepare(WAKE_SQL.open).run(USER, iso(-50));
  db.prepare(WAKE_SQL.close).run(iso(-40), USER);
  db.prepare(WAKE_SQL.open).run(USER, iso(-5));
  db.prepare(WAKE_SQL.open).run("someone-else", iso(-5));
  db.prepare(WAKE_SQL.prune).run(USER, iso(-60 * 24 * 7));
  const rows = db.prepare(WAKE_SQL.usage).all(USER, usageSince(now)) as { started_at: string; stopped_at: string | null }[];
  assert.deepEqual(rows.map((row) => [row.started_at, row.stopped_at]), [[iso(-5), null], [iso(-50), iso(-40)]]);
  assert.deepEqual(machineUsage(rows, now), { wakesLastHour: 2, oldestWake: now - 50 * 60_000, awakeMinutesToday: 15, resetsAt: Date.parse("2026-11-16T00:00:00.000Z") });
  assert.equal((db.prepare("select count(*) as n from machine_wakes").get() as { n: number }).n, 3, "the week-old wake was pruned");
});

test("each user's home key is derived on the gateway, is 32 bytes, and differs per user", async () => {
  const secret = "h".repeat(64);
  const minas = await homeKeyFor(secret, "minas");
  assert.match(minas, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await homeKeyFor(secret, "minas"), minas, "the same on every wake");
  assert.notEqual(await homeKeyFor(secret, "maria"), minas);
  assert.notEqual(await homeKeyFor("i".repeat(64), "minas"), minas);
  assert.equal(loadRunnerConfig({ RUNNER_ACCESS_KEY: "k".repeat(48), CLAUDE_HOME_KEY: minas }).homeKey?.length, 32, "the runner takes it as is");
  await assert.rejects(homeKeyFor(undefined, "minas"), /HOME_ENCRYPTION_KEY/);
  await assert.rejects(homeKeyFor(secret, "../x"), /User ids/);
});
