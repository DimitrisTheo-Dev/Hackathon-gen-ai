import type { Session } from "@supabase/supabase-js";
import { z } from "zod";

export const EMAIL_CODE_LENGTH = 6;
export const EMAIL_RESEND_COOLDOWN_SECONDS = 60;
const emailSchema = z.string().trim().max(254).email();

/** Only email authentication. This interface cannot create workspace memberships or agent grants. */
export interface EmailAuthClient {
  signInWithOtp(input: {
    email: string;
    options: { shouldCreateUser: true };
  }): Promise<{ error: unknown }>;
  verifyOtp(input: {
    email: string;
    token: string;
    type: "email";
  }): Promise<{ data: { session: Session | null }; error: unknown }>;
}
export class EmailAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSeconds = 0,
  ) {
    super(message);
    this.name = "EmailAuthError";
  }
}
export function normalizeEmail(value: string): string {
  const result = emailSchema.safeParse(value);
  if (!result.success)
    throw new EmailAuthError("invalid_email", "Enter a valid email address.");
  return result.data;
}
/** Supports pasted codes with spaces or a visual separator without accepting arbitrary characters. */
export function normalizeEmailCode(value: string): string {
  return value.replace(/[\s-]/g, "");
}
export function emailAuthError(error: unknown, action: "request" | "verify"): EmailAuthError {
  if (error instanceof EmailAuthError) return error;
  const details = typeof error === "object" && error !== null ? error as { code?: unknown; status?: unknown; name?: unknown } : {};
  if (details.status === 429 || details.code === "over_email_send_rate_limit" || details.code === "over_request_rate_limit")
    return new EmailAuthError("rate_limited", "Too many attempts. Wait a minute before trying again. If this continues, try later.", EMAIL_RESEND_COOLDOWN_SECONDS);
  if (details.code === "otp_expired")
    return new EmailAuthError("code_not_valid", "That code has expired or is not valid. Request a new code and try again.");
  if (details.code === "signup_disabled")
    return new EmailAuthError("signup_disabled", "New accounts are not enabled yet. Ask the workspace owner to enable email sign-up.");
  if (details.code === "email_provider_disabled" || details.code === "email_address_not_authorized" || details.code === "otp_disabled")
    return new EmailAuthError("email_unavailable", "Email delivery is not configured for this address yet. Contact the workspace owner.");
  if (details.code === "email_address_invalid" || details.code === "validation_failed")
    return new EmailAuthError("invalid_input", action === "request" ? "Check the email address and try again." : "Check your email address and enter the six-digit code from the latest email.");
  if (details.name === "AuthRetryableFetchError" || error instanceof TypeError)
    return new EmailAuthError("connection_failed", "We couldn’t reach sign-in. Check your connection and try again.");
  return new EmailAuthError(
    action === "request" ? "code_request_failed" : "verification_failed",
    action === "request"
      ? "We couldn’t request a sign-in code. Try again, or contact the workspace owner if it continues."
      : "We couldn’t verify that code. Check the latest email and try again, or request a new code.",
  );
}
export async function requestEmailCode(auth: EmailAuthClient, value: string): Promise<{ email: string; retryAfterSeconds: number }> {
  const email = normalizeEmail(value);
  try {
    const { error } = await auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw error;
    return { email, retryAfterSeconds: EMAIL_RESEND_COOLDOWN_SECONDS };
  } catch (error) { throw emailAuthError(error, "request"); }
}
export async function verifyEmailCode(auth: EmailAuthClient, emailValue: string, codeValue: string): Promise<Session> {
  const email = normalizeEmail(emailValue);
  const token = normalizeEmailCode(codeValue);
  if (!new RegExp(`^[0-9]{${EMAIL_CODE_LENGTH}}$`).test(token))
    throw new EmailAuthError("invalid_code", "Enter the six-digit code from your email.");
  try {
    const { data, error } = await auth.verifyOtp({ email, token, type: "email" });
    if (error) throw error;
    if (!data.session)
      throw new EmailAuthError("session_missing", "The code was checked, but no session was returned. Request a new code and try again.");
    return data.session;
  } catch (error) { throw emailAuthError(error, "verify"); }
}
