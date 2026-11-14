# Faceful email sign-in

Configured on 14 November 2026 in Supabase project `hgsgvdujzatfhsjoojll` through the authenticated dashboard.

- Resend domain `faceful.dtheo.dev`: verified. Existing Froni domain was preserved.
- Sender: **Faceful <signin@faceful.dtheo.dev>**.
- Custom SMTP: enabled, `smtp.resend.com:465`, username `resend`. A dedicated sending-access key is stored in Supabase's encrypted SMTP settings; no key is in application code, environment files or this repository. Its current Resend scope covers all verified domains; narrowing it to Faceful is a recommended follow-up.
- Magic link or OTP and Confirm signup: both use [email-otp.html](../../supabase/templates/email-otp.html), subject **Your Faceful sign-in code**. Both rendered previews were checked after saving and reloading.
- OTP length: changed from 8 to **6**, verified after reopening Email provider settings. Existing expiration remains **3600 seconds**. The email avoids hardcoded expiry copy.
- Email provider, new signups and email confirmation are enabled; anonymous signup remains disabled. Site URL is `https://faceful.dtheo.dev`; no wildcard redirect was added.

The browser requests `signInWithOtp({ email, options: { shouldCreateUser: true } })` and verifies `verifyOtp({ email, token, type: "email" })`. Account creation does not grant workspace membership, roles, publishing approval or agent authority. The browser talks only to Supabase; Supabase sends through Resend.

The UI accepts paste/autofill, uses a 60-second resend cooldown, and keeps request acceptance distinct from session verification. Supabase remains authoritative for expiry and rate limits. Unit and mocked browser tests cover request/verification failures, cooldown and six-digit entry. Actual inbox delivery and fresh-user session verification are separate checks and remain unverified until recorded below.

References: [Resend SMTP configuration](https://resend.com/docs/send-with-supabase-smtp), [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates).
