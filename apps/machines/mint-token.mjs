#!/usr/bin/env node
// Prints a personal gateway token for one user. The signing key comes from FACEFUL_GATEWAY_SIGNING_KEY.
// Keep it out of chat and commits; copy it straight to the clipboard:
//   node apps/machines/mint-token.mjs <user-id> | pbcopy
import { createHmac } from "node:crypto";

const [uid] = process.argv.slice(2);
const secret = process.env.FACEFUL_GATEWAY_SIGNING_KEY ?? "";
if (secret.length < 32) { console.error("Set FACEFUL_GATEWAY_SIGNING_KEY (at least 32 characters)."); process.exit(1); }
if (!uid || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(uid)) { console.error("Usage: mint-token.mjs <user-id>  (lowercase letters, digits, dashes)"); process.exit(1); }
process.stdout.write(`fgw1.${uid}.${createHmac("sha256", secret).update(`fgw1:${uid}`).digest("base64url")}`);
