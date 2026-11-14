import test from "node:test";
import assert from "node:assert/strict";
import type { Session } from "@supabase/supabase-js";
import {
  EmailAuthError, EMAIL_RESEND_COOLDOWN_SECONDS, emailAuthError,
  normalizeEmail, normalizeEmailCode, requestEmailCode, verifyEmailCode,
  type EmailAuthClient,
} from "../apps/web/src/lib/email-auth";

const session = { access_token: "unit-test-token", refresh_token: "unit-test-refresh", expires_in: 3600, token_type: "bearer", user: { id: "unit-test-user", app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: "2026-11-14T12:00:00Z" } } satisfies Session;
function fakeAuth(overrides: Partial<EmailAuthClient> = {}): EmailAuthClient {
  return { signInWithOtp: async () => ({ error: null }), verifyOtp: async () => ({ data: { session }, error: null }), ...overrides };
}

test("email OTP requests normalize email, enable sign-up, and do not carry workspace authority", async () => {
  let payload: unknown;
  const result = await requestEmailCode(fakeAuth({ signInWithOtp: async (input) => { payload = input; return { error: null }; } }), "  Member@example.com  ");
  assert.deepEqual(payload, { email: "Member@example.com", options: { shouldCreateUser: true } });
  assert.deepEqual(result, { email: "Member@example.com", retryAfterSeconds: EMAIL_RESEND_COOLDOWN_SECONDS });
  assert.ok(!JSON.stringify(payload).includes("workspace"));
  assert.ok(!JSON.stringify(payload).includes("approved"));
});

test("verification uses email OTP type and only returns the server-confirmed session", async () => {
  let payload: unknown;
  const result = await verifyEmailCode(fakeAuth({ verifyOtp: async (input) => { payload = input; return { data: { session }, error: null }; } }), " member@example.com ", "123 456");
  assert.deepEqual(payload, { email: "member@example.com", token: "123456", type: "email" });
  assert.equal(result, session);
  assert.equal(normalizeEmailCode("123-456"), "123456");
  assert.equal(normalizeEmailCode(" 123\n456 "), "123456");
});

test("invalid emails and codes never call Supabase", async () => {
  let calls = 0;
  const auth = fakeAuth({ signInWithOtp: async () => { calls++; return { error: null }; }, verifyOtp: async () => { calls++; return { data: { session }, error: null }; } });
  for (const email of ["", "not-an-email", "a@", "a".repeat(255) + "@example.com"]) {
    await assert.rejects(requestEmailCode(auth, email), (error: unknown) => error instanceof EmailAuthError && error.code === "invalid_email");
  }
  for (const code of ["", "12345", "1234567", "123a56", "１２３４５６", "123.456"]) {
    await assert.rejects(verifyEmailCode(auth, "member@example.com", code), (error: unknown) => error instanceof EmailAuthError && error.code === "invalid_code");
  }
  assert.equal(calls, 0);
  assert.equal(normalizeEmail(" member@example.com "), "member@example.com");
});

test("request response errors and rejected promises are handled without exposing raw server content", async () => {
  for (const failure of [{ code: "over_email_send_rate_limit", status: 429, message: "private provider details" }, { code: "unexpected_failure", message: "private provider details" }]) {
    for (const rejects of [false, true]) {
      const auth = fakeAuth({ signInWithOtp: async () => { if (rejects) throw failure; return { error: failure }; } });
      await assert.rejects(requestEmailCode(auth, "member@example.com"), (error: unknown) => {
        assert.ok(error instanceof EmailAuthError);
        assert.ok(!error.message.includes("private provider details"));
        assert.equal(error.code, failure.status === 429 ? "rate_limited" : "code_request_failed");
        assert.equal(error.retryAfterSeconds, failure.status === 429 ? 60 : 0);
        return true;
      });
    }
  }
});

test("verification errors cannot become an authenticated session", async () => {
  for (const failure of [{ code: "otp_expired" }, { status: 429 }, new TypeError("private network details"), { message: "unknown failure" }]) {
    for (const rejects of [false, true]) {
      await assert.rejects(verifyEmailCode(fakeAuth({ verifyOtp: async () => { if (rejects) throw failure; return { data: { session }, error: failure }; } }), "member@example.com", "123456"), EmailAuthError);
    }
  }
  await assert.rejects(verifyEmailCode(fakeAuth({ verifyOtp: async () => ({ data: { session: null }, error: null }) }), "member@example.com", "123456"), (error: unknown) => error instanceof EmailAuthError && error.code === "session_missing");
});

test("actionable auth failures distinguish rate limits, delivery setup, invalid input and connectivity", () => {
  const cases = [
    [{ code: "signup_disabled" }, "signup_disabled"],
    [{ code: "email_provider_disabled" }, "email_unavailable"],
    [{ code: "otp_disabled" }, "email_unavailable"],
    [{ code: "email_address_not_authorized" }, "email_unavailable"],
    [{ code: "email_address_invalid" }, "invalid_input"],
    [{ code: "validation_failed" }, "invalid_input"],
    [{ code: "otp_expired" }, "code_not_valid"],
    [{ name: "AuthRetryableFetchError" }, "connection_failed"],
    [new TypeError("offline"), "connection_failed"],
    [{ code: "over_request_rate_limit" }, "rate_limited"],
  ] as const;
  for (const [input, code] of cases) {
    const result = emailAuthError(input, "request"); assert.equal(result.code, code); assert.ok(result.message.length > 20);
  }
  const existing = new EmailAuthError("example", "Already safe");
  assert.equal(emailAuthError(existing, "verify"), existing);
});
