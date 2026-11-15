#!/usr/bin/env node
// Prints a store token for a runner on your own server: it opens users/<user-id>/ until it expires (30d unless told,
// at most 90d). Cloud machines don't need this; the machines gateway gives each one a 12-hour token and renews it.
// The signing key comes from FACEFUL_STORE_SIGNING_KEY (a keyring "2:<secret>,1:<older>" signs with its first entry).
// Pipe it straight into the runner's .env; never paste it into chat or commits:
//   printf 'STORE_TOKEN=%s\n' "$(node apps/workspace-store/mint-token.mjs <user-id> [ttl])" >> apps/claude-runner/.env
// Same format as src/signed-token.ts (fst2.<version>.<uid>.<issued>.<expires>.<signature>).
import { createHmac } from "node:crypto";

const [uid, ttl = "30d"] = process.argv.slice(2);
const fail = (message) => { console.error(message); process.exit(1); };
const [first = ""] = (process.env.FACEFUL_STORE_SIGNING_KEY ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
const versioned = /^(\d{1,3}):(.+)$/.exec(first);
const [version, secret] = versioned ? [Number(versioned[1]), versioned[2]] : [1, first];
if (secret.length < 32 || version < 1) fail("Set FACEFUL_STORE_SIGNING_KEY (at least 32 characters, or a keyring like 2:<secret>,1:<older secret>).");
if (!uid || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(uid)) fail("Usage: mint-token.mjs <user-id> [ttl: 12h, 30d; at most 90d]  (user ids are lowercase letters, digits, dashes)");
const lifetime = /^([1-9]\d{0,5})([mhd])$/.exec(ttl);
const seconds = lifetime ? Number(lifetime[1]) * { m: 60, h: 3600, d: 86_400 }[lifetime[2]] : 0;
if (!seconds || seconds > 90 * 86_400) fail("The lifetime is minutes, hours or days, like 12h or 30d, and at most 90d.");
const issuedAt = Math.floor(Date.now() / 1000);
const fields = [String(version), uid, String(issuedAt), String(issuedAt + seconds)];
const signature = createHmac("sha256", secret).update(["fst2", "faceful-workspace-store", ...fields].join(":")).digest("base64url");
process.stdout.write(`fst2.${fields.join(".")}.${signature}`);
