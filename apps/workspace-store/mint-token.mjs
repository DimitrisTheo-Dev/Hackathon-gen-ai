#!/usr/bin/env node
// Prints the store token for one user's machine. The signing key comes from FACEFUL_STORE_SIGNING_KEY.
// Pipe it straight into the runner's .env; never paste it into chat or commits:
//   printf 'STORE_TOKEN=%s\n' "$(node apps/workspace-store/mint-token.mjs <user-id>)" >> apps/claude-runner/.env
import { createHmac } from "node:crypto";

const [uid] = process.argv.slice(2);
const secret = process.env.FACEFUL_STORE_SIGNING_KEY ?? "";
if (secret.length < 32) { console.error("Set FACEFUL_STORE_SIGNING_KEY (at least 32 characters)."); process.exit(1); }
if (!uid || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(uid)) { console.error("Usage: mint-token.mjs <user-id>  (lowercase letters, digits, dashes)"); process.exit(1); }
const signature = createHmac("sha256", secret).update(`fst1:${uid}`).digest("base64url");
process.stdout.write(`fst1.${uid}.${signature}`);
