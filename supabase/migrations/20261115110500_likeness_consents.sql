-- Likeness consents: the proof that a person agreed to have their face and voice turned into an avatar.
-- One row per capture (the "Scan my face" flow, packages/engine/src/likeness.ts):
--   1. a guided face scan: straight, then left, right, up and down in a random order, recorded as one
--      video plus a still per angle
--   2. three phrases read aloud (two random ones and the consent statement with the person's name),
--      followed by live transcription and recorded as one video
--   3. liveness checks computed in the browser (checks), kept as evidence rather than as verification
--
-- The recordings live in the private R2 bucket under orgs/<org>/likeness/<user>/; the columns hold their
-- keys, never URLs. Additive only: no existing object is altered or dropped.
--
-- Server only: RLS is on with no policies and browsers have no grants, so every read and write goes through
-- the domain API with the server secret key. A face and a voice are biometric data (GDPR Art. 9), so
-- withdrawing (revoked_at) deletes the files and empties the keys; the row stays as the record of withdrawal.
-- Deleting a workspace or an account cascades to these rows but not to R2: delete the objects under the
-- prefix above as part of that erasure.
begin;

create table public.likeness_consents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_name text not null check (length(subject_name) between 1 and 120),
  language text not null default 'en' check (language in ('en','el')),
  statement text not null check (length(statement) <= 500),
  phrases jsonb not null default '[]',
  transcript text check (transcript is null or length(transcript) <= 5000),
  scan_video_key text,
  speech_video_key text,
  stills jsonb not null default '{}',
  manifest_key text,
  checks jsonb not null default '{}',
  passed boolean not null default false,
  user_agent text check (user_agent is null or length(user_agent) <= 500),
  ip_address text check (ip_address is null or length(ip_address) <= 64),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index likeness_consents_org on public.likeness_consents(org_id, created_at desc);
create index likeness_consents_user on public.likeness_consents(user_id, created_at desc);

alter table public.likeness_consents enable row level security;
revoke all on public.likeness_consents from anon, authenticated;

commit;
