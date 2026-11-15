-- Social accounts and their activity (packages/engine/src/socials.ts, socials-buffer.ts, socials-events.ts).
--
-- 1. provider_connections learns which provider an account was connected through (Buffer today, Faceful's own
--    integration later), and stops listing platforms in a constraint: the engine's SOCIAL_PLATFORMS list decides,
--    so a new platform is a code change only. The same account can be connected through two providers.
-- 2. social_events holds what happens on connected accounts (comments, likes, messages, posts, stories) in one
--    shape, whoever delivered it.
--
-- publish_jobs is untouched: the studio still schedules to Instagram, TikTok and YouTube only.
-- Both tables are server only: RLS is on and browsers have no grants, so every read and write goes through the
-- domain API. provider_connections holds encrypted provider credentials; social_events holds private messages.
begin;

alter table public.provider_connections
  drop constraint provider_connections_platform_check,
  add constraint provider_connections_platform_check check (platform ~ '^[a-z][a-z0-9_]{1,31}$'),
  add column provider text not null default 'direct' check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  add column provider_account_id text,
  add column profile_url text,
  drop constraint provider_connections_org_id_platform_external_account_id_key,
  add constraint provider_connections_account_key unique (org_id, provider, platform, external_account_id);
-- Webhook deliveries name an account by its ID on the platform.
create index provider_connections_external on public.provider_connections(platform, external_account_id);

create table public.social_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  account_id uuid references public.provider_connections(id) on delete set null,
  platform text not null check (platform ~ '^[a-z][a-z0-9_]{1,31}$'),
  -- "comment.created", "message.received", ... The engine's SOCIAL_EVENT_TYPES list decides which are accepted.
  type text not null check (type ~ '^[a-z_]{1,40}\.[a-z_]{1,40}$'),
  -- Who delivered it: "webhook", a provider ("buffer") or a platform.
  source text not null check (length(source) between 1 and 32),
  -- The sender's ID for the event. A repeated delivery is ignored.
  external_id text not null check (length(external_id) between 1 and 200),
  occurred_at timestamptz not null,
  actor jsonb,
  subject jsonb,
  text text check (text is null or length(text) <= 5000),
  data jsonb not null default '{}',
  received_at timestamptz not null default now(),
  unique (org_id, platform, type, external_id)
);
create index social_events_org on public.social_events(org_id, received_at desc);
create index social_events_account on public.social_events(account_id, received_at desc);

alter table public.social_events enable row level security;
revoke all on public.social_events from anon, authenticated;

commit;
