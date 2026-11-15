-- Reel production: timelines, draft files and render jobs for presenter-led shorts.
-- Additive only. Written by the domain API with the server secret key; members may read their workspace's rows.
-- File bytes live in Cloudflare R2 (bucket faceful-media); these tables hold metadata and keys only.
begin;

-- The Remotion timeline over one content item (video layers, audio, cards, captions, transcript).
create table public.video_compositions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  item_id uuid not null references public.content_items(id) on delete cascade,
  revision integer not null check (revision > 0),
  composition jsonb not null check (jsonb_typeof(composition) = 'object'),
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, item_id)
);
create index video_compositions_project on public.video_compositions(org_id, project_id);

-- Every component of a reel as its own versioned draft: script, facts, voice, clips, music, SFX, images, transcripts, renders.
create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  item_id uuid references public.content_items(id) on delete set null,
  kind text not null check (kind in ('script','facts','voice','transcript','avatar_clip','video','image','music','sfx','captions','cut_list','render','other')),
  name text not null check (length(name) between 1 and 160),
  mime text not null,
  bytes bigint not null check (bytes >= 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  duration_seconds numeric check (duration_seconds is null or duration_seconds >= 0),
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object'),
  state text not null default 'pending' check (state in ('pending','ready','archived')),
  version integer not null check (version > 0),
  storage_key text not null check (storage_key like 'orgs/' || org_id::text || '/projects/' || project_id::text || '/files/%'),
  created_by text not null,
  actor_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (org_id, project_id, item_id, name, version)
);
create index project_files_project on public.project_files(org_id, project_id, created_at desc);

-- Render jobs claimed by Remotion workers (VPS, boxd, containers). The composition is a snapshot of the saved revision.
create table public.reel_renders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  item_id uuid not null references public.content_items(id) on delete cascade,
  composition_revision integer not null check (composition_revision > 0),
  composition jsonb not null,
  state text not null default 'queued' check (state in ('queued','rendering','succeeded','failed','cancelled')),
  progress real not null default 0 check (progress between 0 and 1),
  worker_id text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  output_file_id uuid references public.project_files(id) on delete set null,
  error text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reel_renders_queue on public.reel_renders(state, created_at);
create index reel_renders_item on public.reel_renders(org_id, item_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['video_compositions','project_files','reel_renders'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select private.is_org_member(org_id)))', t || '_member_read', t);
  end loop;
end $$;

commit;
