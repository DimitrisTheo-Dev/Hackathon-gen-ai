import { createHmac } from "node:crypto";
import { requireHuman, type Ctx, type EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";

/**
 * The Claude Code machines gateway (apps/machines) runs on a separate Cloudflare account, so the studio never sends it
 * the person's Faceful session: that session would open the whole studio API (approve, publish, billing) to whoever
 * runs the gateway or reads its logs. `POST /v1/studio/machines/token` trades the session for a token that only the
 * gateway accepts, for one user, for ten minutes. Same format as apps/workspace-store/src/signed-token.ts:
 *   fgs1.<key version>.<uid>.<issued at>.<expires at>.<base64url HMAC-SHA256(MACHINES_GATEWAY_KEY, "fgs1:faceful-machines:…")>
 */
const KIND = "fgs1";
const AUDIENCE = "faceful-machines";
export const MACHINES_TOKEN_TTL_SECONDS = 10 * 60;

export function machinesToken(deps: EngineDeps, ctx: Ctx): { token: string; expiresAt: string } {
  // Only the signed-in person, never an agent: a machine runs Claude Code with their own Claude sign-in.
  requireHuman(ctx, "Opening a cloud machine");
  const { gatewayKey, allowedUsers } = deps.config.machines;
  if (!gatewayKey) throw new EngineError("unsupported", "Cloud machines aren't set up on this deployment.");
  const uid = (ctx.principal as { userId: string }).userId.toLowerCase();
  // The gateway checks its own list too; refusing here as well means a token is never minted for someone it would turn away.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(uid) || !allowedUsers.includes(uid))
    throw new EngineError("forbidden", "Cloud machines are invite-only for now. Ask the Faceful team to turn one on for your account.");
  const issuedAt = Math.floor(deps.now().getTime() / 1000);
  const fields = [String(gatewayKey.version), uid, String(issuedAt), String(issuedAt + MACHINES_TOKEN_TTL_SECONDS)];
  const signature = createHmac("sha256", gatewayKey.secret).update([KIND, AUDIENCE, ...fields].join(":")).digest("base64url");
  return { token: `${KIND}.${fields.join(".")}.${signature}`, expiresAt: new Date((issuedAt + MACHINES_TOKEN_TTL_SECONDS) * 1000).toISOString() };
}
