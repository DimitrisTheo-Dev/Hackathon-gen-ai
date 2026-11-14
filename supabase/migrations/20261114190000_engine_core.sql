-- Faceful/Castroom shared domain engine. Additive only: no existing object is altered or dropped.
-- All writes go through the domain API with the server secret key. Browsers get member-scoped
-- SELECT on non-sensitive tables only; billing, tokens and idempotency ledgers have no client access.
begin;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  type text not null default 'personal' check (type in ('personal','company','agency')),
  timezone text not null default 'Europe/Athens',
  personal_owner_id uuid unique references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create table public.memberships (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','editor','reviewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user on public.memberships(user_id);
create table public.user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_org_id uuid references public.organizations(id) on delete set null,
  updated_at timestamptz not null default now()
);
create table public.brand_profiles (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  name text not null default '',
  description text not null default '',
  rules jsonb not null default '[]',
  color text not null default '#5F6C66',
  tone text not null default '',
  audience text not null default '',
  preferred_avatar_id text,
  updated_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text not null check (length(title) between 1 and 160),
  brief text not null default '',
  company_context jsonb,
  sources jsonb not null default '[]',
  timezone text not null,
  revision integer not null default 1 check (revision > 0),
  human_interventions integer not null default 0,
  origin text not null default 'user' check (origin in ('user','agent','sample')),
  template_id text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_org on public.projects(org_id, updated_at desc);

create table public.content_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  position integer not null default 0,
  kind text not null default 'avatar_video' check (kind in ('avatar_video','image','text')),
  title text not null,
  script text not null default '',
  avatar_id text,
  language text not null default 'en',
  style jsonb not null,
  variants jsonb not null default '[]',
  targets jsonb not null default '[]',
  source_ids jsonb not null default '[]',
  revision integer not null default 1 check (revision > 0),
  render_revision integer,
  approved_revision integer,
  status text not null default 'draft' check (status in ('draft','queued','rendering','ready','needs_review','failed')),
  media_asset_id uuid,
  updated_at timestamptz not null default now()
);
create index content_items_project on public.content_items(project_id, position);
create index content_items_org on public.content_items(org_id);

-- Immutable history: one row per saved revision. Restoring writes a NEW revision.
create table public.content_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  item_id uuid not null references public.content_items(id) on delete cascade,
  revision integer not null check (revision > 0),
  snapshot jsonb not null,
  affects_render boolean not null default true,
  summary text not null default '',
  actor_id text not null,
  actor_kind text not null check (actor_kind in ('human','agent','system')),
  created_at timestamptz not null default now(),
  unique (item_id, revision)
);

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  item_id uuid not null references public.content_items(id) on delete cascade,
  revision integer not null,
  storage_path text not null unique,
  mime text not null,
  bytes bigint not null check (bytes > 0),
  sha256 text not null,
  duration_seconds numeric not null check (duration_seconds > 0),
  has_audio boolean not null,
  width integer,
  height integer,
  origin text not null check (origin in ('render','worker_upload','sample')),
  provider text,
  render_job_id uuid,
  created_at timestamptz not null default now()
);
create index media_assets_item on public.media_assets(item_id, created_at desc);

create table public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  item_id uuid not null references public.content_items(id) on delete cascade,
  revision integer not null,
  state text not null default 'queued' check (state in ('queued','running','succeeded','failed','unknown','cancel_requested','cancelled')),
  stage text not null default 'render' check (stage in ('draft','brand_check','render','compose','publish')),
  provider text not null,
  provider_job_id text,
  provider_status text,
  avatar_id text,
  script text not null,
  language text not null,
  settings jsonb not null default '{}',
  attempt integer not null default 0,
  credits_reserved integer not null default 0,
  credits_settled boolean not null default false,
  error jsonb,
  media_asset_id uuid,
  claimed_by text,
  claimed_at timestamptz,
  correlation_id text not null,
  idempotency_key text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, item_id, revision, idempotency_key)
);
create index render_jobs_state on public.render_jobs(state, created_at);
create index render_jobs_project on public.render_jobs(project_id, created_at desc);
-- At most one live render per item revision: retries/replays cannot double-render or double-charge.
create unique index render_jobs_one_active on public.render_jobs(item_id, revision) where state in ('queued','running','cancel_requested');

create table public.job_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null,
  job_kind text not null check (job_kind in ('render','publish')),
  type text not null,
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);
create index job_events_job on public.job_events(job_id, at);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid,
  actor text not null,
  actor_kind text not null check (actor_kind in ('human','agent','system')),
  action text not null,
  object_id text not null,
  revision integer,
  outcome text not null,
  correlation_id text,
  at timestamptz not null default now()
);
create index audit_events_project on public.audit_events(project_id, at desc);
create index audit_events_org on public.audit_events(org_id, at desc);

-- Idempotency ledger for every side-effecting operation (UI and MCP share it).
create table public.operations (
  org_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  name text not null,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (org_id, key)
);

create table public.schedule_manifests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  project_revision integer not null,
  hash text not null,
  entries jsonb not null,
  blockers jsonb not null,
  state text not null default 'required' check (state in ('required','approved','stale','committed')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  expires_at timestamptz not null,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index schedule_manifests_project on public.schedule_manifests(project_id, created_at desc);

create table public.publish_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  manifest_id uuid not null references public.schedule_manifests(id) on delete cascade,
  item_id uuid not null references public.content_items(id) on delete cascade,
  revision integer not null,
  media_asset_id uuid not null,
  platform text not null check (platform in ('instagram','tiktok','youtube')),
  account_id text not null,
  scheduled_at timestamptz not null,
  timezone text not null,
  payload jsonb not null,
  state text not null default 'scheduled' check (state in ('scheduled','processing','submitted','verified_published','failed','cancelled')),
  attempt integer not null default 0,
  next_attempt_at timestamptz,
  provider_post_id text,
  published_url text,
  published_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One publication intent per approved manifest entry, across retries and recreated approvals.
  unique (item_id, revision, platform, account_id, scheduled_at)
);
create index publish_jobs_due on public.publish_jobs(state, scheduled_at);

create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  platform text not null check (platform in ('instagram','tiktok','youtube')),
  display_name text not null,
  external_account_id text not null,
  state text not null default 'connected' check (state in ('connected','expired','unavailable')),
  scopes jsonb not null default '[]',
  credentials_ciphertext text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, platform, external_account_id)
);

-- Scoped workspace tokens for agent clients. Only a SHA-256 digest is stored.
create table public.agent_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  display_name text not null,
  token_sha256 text not null unique,
  scopes jsonb not null,
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index agent_connections_org on public.agent_connections(org_id, created_at desc);

create table public.billing_customers (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  stripe_customer_id text not null unique,
  livemode boolean not null default false check (livemode = false),
  created_at timestamptz not null default now()
);
create table public.billing_state (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  status text not null default 'free' check (status in ('free','checkout_pending','trialing','active','past_due','cancelled','incomplete','unpaid','paused')),
  plan_key text,
  stripe_subscription_id text unique,
  stripe_price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  last_event_created bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table public.checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  stripe_session_id text not null unique,
  price_key text not null,
  state text not null default 'pending' check (state in ('pending','completed','expired','failed')),
  url text,
  created_by text not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
create table public.stripe_events (
  event_id text primary key,
  type text not null,
  created bigint not null,
  outcome text not null default 'received',
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
-- Append-only credit ledger. `ref` is unique per org so a replayed grant/charge is a no-op.
create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  delta integer not null check (delta <> 0),
  reason text not null check (reason in ('starter_grant','subscription_grant','render_hold','render_release','adjustment')),
  ref text not null,
  created_at timestamptz not null default now(),
  unique (org_id, ref)
);
create index credit_ledger_org on public.credit_ledger(org_id, created_at desc);

-- Atomic admission: take a credit hold only if the balance covers it. Returns the new balance or NULL.
create or replace function public.engine_hold_credits(p_org uuid, p_amount integer, p_ref text)
returns integer language plpgsql security definer set search_path = '' as $$
declare balance integer;
begin
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text, 0));
  if exists (select 1 from public.credit_ledger where org_id = p_org and ref = p_ref) then
    return (select coalesce(sum(delta), 0) from public.credit_ledger where org_id = p_org);
  end if;
  select coalesce(sum(delta), 0) into balance from public.credit_ledger where org_id = p_org;
  if balance < p_amount then return null; end if;
  insert into public.credit_ledger(org_id, delta, reason, ref) values (p_org, -p_amount, 'render_hold', p_ref);
  return balance - p_amount;
end $$;
revoke all on function public.engine_hold_credits(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.engine_hold_credits(uuid, integer, text) to service_role;

-- Membership helper for RLS. SECURITY DEFINER avoids recursive policy evaluation on memberships.
create schema if not exists private;
create or replace function private.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = (select auth.uid()));
$$;
revoke all on function private.is_org_member(uuid) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_org_member(uuid) to authenticated;

do $$
declare t text;
begin
  -- Every engine table: RLS on, nothing granted to browsers by default.
  foreach t in array array['organizations','memberships','user_state','brand_profiles','projects','content_items','content_versions','media_assets','render_jobs','job_events','audit_events','operations','schedule_manifests','publish_jobs','provider_connections','agent_connections','billing_customers','billing_state','checkout_sessions','stripe_events','credit_ledger'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
  -- Member-readable, never client-writable. Secrets/ledgers stay server-only.
  foreach t in array array['brand_profiles','projects','content_items','content_versions','media_assets','render_jobs','job_events','audit_events','schedule_manifests','publish_jobs'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select private.is_org_member(org_id)))', t || '_member_read', t);
  end loop;
end $$;
grant select on public.organizations, public.memberships to authenticated;
create policy organizations_member_read on public.organizations for select to authenticated using ((select private.is_org_member(id)));
create policy memberships_self_read on public.memberships for select to authenticated using (user_id = (select auth.uid()));

-- Private bucket for rendered media. Playback uses short-lived signed URLs issued by the API.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 209715200, array['video/mp4','video/webm','image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

commit;
