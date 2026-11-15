import test from "node:test";
import assert from "node:assert/strict";
import { mintSignedToken, parseKeyring, verifySignedToken } from "../apps/workspace-store/src/signed-token";

const OLD = "o".repeat(40);
const NEW = "n".repeat(40);
const NOW = Date.parse("2026-11-15T10:00:00.000Z");

test("keyrings: a bare secret is version 1, the first entry signs, short or repeated keys are refused", () => {
  assert.deepEqual(parseKeyring(OLD), { version: 1, secret: OLD, all: new Map([[1, OLD]]) });
  const ring = parseKeyring(` 2:${NEW} , 1:${OLD} `)!;
  assert.deepEqual([ring.version, ring.secret, [...ring.all.keys()]], [2, NEW, [2, 1]]);
  for (const bad of [undefined, "", "short", `0:${NEW}`, `2:${NEW},2:${OLD}`, `2:${NEW},1:short`]) assert.equal(parseKeyring(bad), null, String(bad));
});

test("a token is bound to its kind, audience, user, key version and lifetime", async () => {
  const ring = parseKeyring(`2:${NEW},1:${OLD}`)!;
  const token = await mintSignedToken(ring, "fgs1", "faceful-machines", "minas", 600, NOW);
  assert.match(token, /^fgs1\.2\.minas\.\d{10}\.\d{10}\.[A-Za-z0-9_-]{43}$/);
  const verify = (value: string, options: { kind?: string; audience?: string; keys?: string; max?: number; at?: number } = {}) =>
    verifySignedToken(parseKeyring(options.keys ?? `2:${NEW},1:${OLD}`), options.kind ?? "fgs1", options.audience ?? "faceful-machines", value, options.max ?? 900, options.at ?? NOW);
  assert.deepEqual(await verify(token), { uid: "minas", version: 2, issuedAt: NOW / 1000, expiresAt: NOW / 1000 + 600 });
  assert.equal(await verify(token, { kind: "fgw2" }), null, "another kind");
  assert.equal(await verify(token.replace(/^fgs1/, "fgw2"), { kind: "fgw2" }), null, "relabelled");
  assert.equal(await verify(token, { audience: "faceful-workspace-store" }), null, "another audience");
  assert.equal(await verify(token, { keys: `2:${OLD}` }), null, "another key under the same version");
  assert.equal(await verify(token, { keys: `1:${OLD}` }), null, "its key version was retired");
  assert.equal(await verify(token, { max: 300 }), null, "lives longer than this kind may");
  assert.equal(await verify(token, { at: NOW + 600_000 }), null, "expired");
  assert.equal(await verify(token, { at: NOW - 120_000 }), null, "issued in the future");
  assert.ok(await verify(token, { at: NOW - 30_000 }), "a little clock difference is fine");
  const [kind, version, uid, issued, expires, signature] = token.split(".");
  for (const forged of [
    [kind, version, "admin", issued, expires, signature],
    [kind, version, uid, issued, String(Number(expires) + 86_400), signature],
    [kind, "1", uid, issued, expires, signature],
    [kind, `0${version}`, uid, issued, expires, signature],
    [kind, version, uid, issued, expires, `${signature.slice(0, -1)}A`],
  ]) assert.equal(await verify(forged.join(".")), null, forged.join("."));
  await assert.rejects(mintSignedToken(ring, "fgs1", "faceful-machines", "Not Valid", 60), /User ids/);
  await assert.rejects(mintSignedToken(ring, "fgs1", "faceful-machines", "minas", 0), /lifetime/);
});
