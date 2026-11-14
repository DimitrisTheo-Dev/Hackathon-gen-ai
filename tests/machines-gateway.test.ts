import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { asSaveRecord, corsFor, createLineScanner, createSessionVerifier, identify, mintGatewayToken, parseOrigins, parseRunEvent, slugify, verifyGatewayToken } from "../apps/machines/src/lib";

const SECRET = "g".repeat(64);
const SUPABASE = "https://project.supabase.co";
const USER = "3f2c1d7e-aaaa-4bbb-8ccc-000000000001";

async function sessions() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const verify = createSessionVerifier(SUPABASE, createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "ES256", kid: "k1" }] }));
  const token = (claims: Record<string, unknown> = {}, options: { issuer?: string; audience?: string; expires?: string } = {}) =>
    new SignJWT({ role: "authenticated", ...claims }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject(USER).setIssuer(options.issuer ?? `${SUPABASE}/auth/v1`).setAudience(options.audience ?? "authenticated").setIssuedAt().setExpirationTime(options.expires ?? "5m").sign(privateKey);
  return { verify, token };
}

test("personal tokens are per user and can't be forged", async () => {
  const token = await mintGatewayToken(SECRET, "minas");
  assert.match(token, /^fgw1\.minas\.[A-Za-z0-9_-]{43}$/);
  assert.equal(await verifyGatewayToken(SECRET, token), "minas");
  assert.equal(await verifyGatewayToken(SECRET, token.replace("minas", "admin")), null);
  assert.equal(await verifyGatewayToken("h".repeat(64), token), null);
  assert.equal(await verifyGatewayToken(undefined, token), null);
  await assert.rejects(mintGatewayToken(SECRET, "Not Valid"), /User ids/);
  const cli = execFileSync(process.execPath, ["apps/machines/mint-token.mjs", "minas"], { env: { ...process.env, FACEFUL_GATEWAY_SIGNING_KEY: SECRET } }).toString();
  assert.equal(cli, token);
});

test("Faceful sessions are verified by signature, issuer, audience and expiry", async () => {
  const { verify, token } = await sessions();
  assert.equal(await verify(await token()), USER);
  assert.equal(await verify(await token({}, { issuer: "https://evil.example/auth/v1" })), null);
  assert.equal(await verify(await token({}, { audience: "anon" })), null);
  assert.equal(await verify(await token({}, { expires: "-1m" })), null);
  assert.equal(await verify(await token({ role: "anon" })), null);
  assert.equal(await verify(await token({ is_anonymous: true })), null);
  assert.equal(await verify(await token({ client_id: "external-agent" })), null, "agent tokens don't get a machine");
  const other = await sessions();
  assert.equal(await verify(await other.token()), null, "signed by a different key");
  assert.equal(await verify("not.a.jwt"), null);
});

test("the caller is identified from the credential only", async () => {
  const { verify, token } = await sessions();
  const deps = { signingKey: SECRET, verifySession: verify };
  assert.deepEqual(await identify(`Bearer ${await mintGatewayToken(SECRET, "minas")}`, deps), { uid: "minas", via: "token" });
  assert.deepEqual(await identify(`Bearer ${await token()}`, deps), { uid: USER, via: "session" });
  assert.equal(await identify("Bearer fgw1.minas.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", deps), null);
  assert.equal(await identify(null, deps), null);
  assert.equal(await identify(`Bearer ${await mintGatewayToken(SECRET, "minas")}`, { verifySession: verify }), null, "no signing key, no personal tokens");
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
