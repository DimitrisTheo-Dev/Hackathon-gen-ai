-- Clone a video: a person points at a short video on YouTube, TikTok or Instagram, says what to keep and what to
-- change, and the studio queues a clone job (packages/engine/src/clone.ts). Additive only: no existing object is
-- altered or dropped.
-- The source video is never downloaded or stored: a row keeps its canonical link, the platform's embed player and
-- the title and author the platform's oEmbed gave. A job stays `queued` until a worker takes it; creating one makes,
-- charges and publishes nothing. All writes go through the engine with the server secret key.
begin;

create table public.clone_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- The source, as the engine resolved it.
  platform text not null check (platform in ('youtube', 'tiktok', 'instagram')),
  kind text not null check (kind in ('video', 'short', 'reel', 'post')),
  source_id text not null check (source_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  source_url text not null check (source_url like 'https://%' and length(source_url) <= 2048),
  embed_url text not null check (embed_url like 'https://%' and length(embed_url) <= 2048),
  orientation text not null check (orientation in ('portrait', 'landscape')),
  source_title text check (length(source_title) <= 300),
  source_author text check (length(source_author) <= 200),
  source_author_url text check (source_author_url like 'https://%'),
  source_thumbnail_url text check (source_thumbnail_url like 'https://%'),
  -- What the person asked for: their own words, and what to borrow from the source.
  brief text not null check (length(brief) between 1 and 4000),
  clone text[] not null check (
    cardinality(clone) between 1 and 9
    and clone <@ array['structure', 'pacing', 'transitions', 'captions', 'graphics', 'sound', 'music', 'voice', 'colours']
  ),
  state text not null default 'queued' check (state in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- {code, message} when a worker gives up; message is shown to the person.
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  -- What a worker made: the project the clone lives in and its rendered video.
  project_id uuid references public.projects(id) on delete set null,
  media_asset_id uuid references public.media_assets(id) on delete set null,
  claimed_by text,
  claimed_at timestamptz,
  idempotency_key text not null,
  correlation_id text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
-- The studio lists a workspace's jobs newest first; a worker would take the oldest queued job.
create index clone_jobs_org_created on public.clone_jobs (org_id, created_at desc);
create index clone_jobs_queued on public.clone_jobs (created_at) where state = 'queued';

-- RLS on, like every engine table: members may read their workspace's jobs; only the engine writes.
alter table public.clone_jobs enable row level security;
revoke all on public.clone_jobs from anon, authenticated;
grant select on public.clone_jobs to authenticated;
create policy clone_jobs_member_read on public.clone_jobs for select to authenticated using ((select private.is_org_member(org_id)));
comment on table public.clone_jobs is 'Clone-a-video jobs. Source videos are referenced by link and embed only, never stored. Written only by the engine with the server secret key; queued until a worker takes them.';

commit;
