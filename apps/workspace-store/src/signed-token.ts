// Expiring, key-versioned HMAC tokens for the machines gateway and the workspace store:
//
//   <kind>.<key version>.<user id>.<issued at>.<expires at>.<base64url HMAC-SHA256(key, "<kind>:<audience>:<version>:<uid>:<iat>:<exp>")>
//
// Times are Unix seconds. A signing key is a keyring, "2:<secret>,1:<older secret>": the first entry signs and every
// entry verifies, so a key is rotated by adding a version in front and retired, with every token it signed, by
// deleting it. A bare secret is version 1. The same format is minted by packages/engine/src/machines.ts and by the
// two mint-token.mjs scripts with node:crypto; the tests check they agree. Pure WebCrypto, so Workers and Node both run it.

export type Keyring = { version: number; secret: string; all: Map<number, string> };
export type TokenClaims = { uid: string; version: number; issuedAt: number; expiresAt: number };

/** A Supabase user UUID or a short slug. */
export const isUserId = (value: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);

export function parseKeyring(value: string | undefined): Keyring | null {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const match = /^(\d{1,3}):(.+)$/.exec(entry);
    return match ? { version: Number(match[1]), secret: match[2] } : { version: 1, secret: entry };
  });
  if (!entries.length || entries.some((entry) => entry.version < 1 || entry.secret.length < 32)) return null;
  const all = new Map(entries.map((entry) => [entry.version, entry.secret]));
  if (all.size !== entries.length) return null; // the same version twice is a typo, not a rotation
  return { version: entries[0].version, secret: entries[0].secret, all };
}

const encoder = new TextEncoder();
async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  let binary = "";
  for (const byte of new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const sameText = (a: string, b: string) => {
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
};

export async function mintSignedToken(keyring: Keyring, kind: string, audience: string, uid: string, ttlSeconds: number, now = Date.now()): Promise<string> {
  if (!isUserId(uid)) throw new Error("User ids are lowercase letters, digits and dashes.");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) throw new Error("A token needs a lifetime of at least one second.");
  const issuedAt = Math.floor(now / 1000);
  const fields = [String(keyring.version), uid, String(issuedAt), String(issuedAt + ttlSeconds)];
  return `${kind}.${fields.join(".")}.${await hmac(keyring.secret, [kind, audience, ...fields].join(":"))}`;
}

/** The claims of a `kind` token for `audience` that this keyring signed, in date and living no longer than `maxTtlSeconds`. */
export async function verifySignedToken(keyring: Keyring | null, kind: string, audience: string, token: string, maxTtlSeconds: number, now = Date.now()): Promise<TokenClaims | null> {
  const match = /^([a-z0-9]{2,8})\.([1-9]\d{0,2})\.([a-z0-9][a-z0-9-]{0,63})\.([1-9]\d{0,11})\.([1-9]\d{0,11})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!keyring || !match || match[1] !== kind) return null;
  const [version, issuedAt, expiresAt] = [Number(match[2]), Number(match[4]), Number(match[5])];
  const secret = keyring.all.get(version);
  const seconds = now / 1000;
  // A minute of clock difference between the minting and the checking machine is allowed, no more.
  if (!secret || expiresAt <= seconds || issuedAt > seconds + 60 || expiresAt <= issuedAt || expiresAt - issuedAt > maxTtlSeconds) return null;
  const expected = await hmac(secret, [kind, audience, match[2], match[3], match[4], match[5]].join(":"));
  return sameText(expected, match[6]) ? { uid: match[3], version, issuedAt, expiresAt } : null;
}
