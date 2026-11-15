-- When the engine last asked a platform to send an account's activity to its webhook address
-- (packages/engine/src/socials-events.ts, renewWebhookSubscriptions). Used for YouTube, whose hub forgets a
-- subscription after some days: the scheduler asks again once this is two days old.
-- Additive only. Null means "never asked", which is also right for every existing row.
alter table public.provider_connections add column webhook_renewed_at timestamptz;
