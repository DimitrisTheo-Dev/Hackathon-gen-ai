#!/usr/bin/env node
// Prints a personal gateway token for one user that expires after a set time: 30m, 12h, 7d (the default), at most 30d.
// The signing key comes from FACEFUL_GATEWAY_SIGNING_KEY, the gateway's GATEWAY_SIGNING_KEY; a keyring
// "2:<secret>,1:<older>" signs with its first entry. The user id must also be in the gateway's MACHINE_ALLOWED_USERS.
// Rotating the key (a new version in front, then dropping the old one) revokes every token it signed.
// Keep tokens out of chat and commits; copy one straight to the clipboard:
//   node apps/machines/mint-token.mjs <user-id> [ttl] | pbcopy
// Same format as apps/workspace-store/src/signed-token.ts (fgw2.<version>.<uid>.<issued>.<expires>.<signature>).
import { createHmac } from "node:crypto";

const [uid, ttl = "7d"] = process.argv.slice(2);
const fail = (message) => { console.error(message); process.exit(1); };
const [first = ""] = (process.env.FACEFUL_GATEWAY_SIGNING_KEY ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
const versioned = /^(\d{1,3}):(.+)$/.exec(first);
const [version, secret] = versioned ? [Number(versioned[1]), versioned[2]] : [1, first];
if (secret.length < 32 || version < 1) fail("Set FACEFUL_GATEWAY_SIGNING_KEY (at least 32 characters, or a keyring like 2:<secret>,1:<older secret>).");
if (!uid || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(uid)) fail("Usage: mint-token.mjs <user-id> [ttl: 30m, 12h, 7d; at most 30d]  (user ids are lowercase letters, digits, dashes)");
const lifetime = /^([1-9]\d{0,5})([mhd])$/.exec(ttl);
const seconds = lifetime ? Number(lifetime[1]) * { m: 60, h: 3600, d: 86_400 }[lifetime[2]] : 0;
if (!seconds || seconds > 30 * 86_400) fail("The lifetime is minutes, hours or days, like 30m, 12h or 7d, and at most 30d.");
const issuedAt = Math.floor(Date.now() / 1000);
const fields = [String(version), uid, String(issuedAt), String(issuedAt + seconds)];
const signature = createHmac("sha256", secret).update(["fgw2", "faceful-machines", ...fields].join(":")).digest("base64url");
process.stdout.write(`fgw2.${fields.join(".")}.${signature}`);
