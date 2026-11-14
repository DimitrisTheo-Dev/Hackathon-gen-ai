-- Conversation UI history is NOT authoritative workflow/audit/approval state.
-- Fail closed until the domain service provisions verified campaign access.
-- The service must revoke these grants when membership/campaign access is revoked.
-- Never populate grants from a browser request or user-editable JWT metadata.
begin;
create table public.castroom_director_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id text not null check (length(workspace_id) between 1 and 160),
  campaign_id text not null check (length(campaign_id) between 1 and 160),
  primary key (user_id,workspace_id,campaign_id)
);
alter table public.castroom_director_access enable row level security;
revoke all on public.castroom_director_access from anon, authenticated;
grant select on public.castroom_director_access to authenticated;
create policy director_access_self on public.castroom_director_access for select to authenticated using (user_id=(select auth.uid()));

create table public.castroom_director_entries (
  id uuid primary key,
  entry_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  workspace_id text not null,
  campaign_id text not null,
  body jsonb not null check (jsonb_typeof(body)='object' and octet_length(body::text)<=100000),
  created_at timestamptz not null default now(),
  foreign key (user_id,workspace_id,campaign_id) references public.castroom_director_access(user_id,workspace_id,campaign_id) on delete cascade
);
create index director_entries_owner_campaign on public.castroom_director_entries(user_id,workspace_id,campaign_id,created_at);
alter table public.castroom_director_entries enable row level security;
revoke all on public.castroom_director_entries from anon,authenticated;
grant select,insert on public.castroom_director_entries to authenticated;
create policy director_entries_select on public.castroom_director_entries for select to authenticated using (
  user_id=(select auth.uid()) and exists(select 1 from public.castroom_director_access a where a.user_id=castroom_director_entries.user_id and a.workspace_id=castroom_director_entries.workspace_id and a.campaign_id=castroom_director_entries.campaign_id)
);
create policy director_entries_insert on public.castroom_director_entries for insert to authenticated with check (
  user_id=(select auth.uid()) and exists(select 1 from public.castroom_director_access a where a.user_id=castroom_director_entries.user_id and a.workspace_id=castroom_director_entries.workspace_id and a.campaign_id=castroom_director_entries.campaign_id)
);
comment on table public.castroom_director_entries is 'User-owned conversation notes only. Never use as approval evidence, provider receipts, audit authority, or job dispatch.';
commit;
