-- Video compositions: the Remotion edit layer (captions, cards, b-roll, music) over one content item.
-- Additive only. Written by the domain API with the server secret key; members may read their workspace's rows.
begin;

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

alter table public.video_compositions enable row level security;
revoke all on public.video_compositions from anon, authenticated;
grant select on public.video_compositions to authenticated;
create policy video_compositions_member_read on public.video_compositions
  for select to authenticated using ((select private.is_org_member(org_id)));

commit;
