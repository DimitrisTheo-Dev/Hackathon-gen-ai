-- Personas and their looks (packages/engine/src/personas.ts, the studio's Personas tab).
--
-- A persona is a presenter a workspace can put in its videos: a name, a short description and a language,
-- made from one person's face scan and spoken consent (public.likeness_consents). Each persona needs its own,
-- new consent: one consent backs at most one persona, and a persona without a live consent cannot be used.
-- The consent is recorded by the person themself at /face-scan?persona=<id>; nobody can attach someone else's.
--
-- A look is one way the persona appears on screen: what they wear, their hair, the setting, with an optional
-- reference photo. A persona can have several looks; every look is covered by the persona's consent.
--
-- Reference photos live in the private R2 bucket under orgs/<org>/personas/<persona>/; the column holds the key,
-- never a URL. Deleting a persona deletes its looks and their photos, but never the consent: withdrawing a
-- consent is the person's own act (DELETE /v1/studio/likeness/consents/:id). A withdrawn or erased consent
-- leaves the persona in place, unusable until a new consent is recorded for it.
--
-- Additive only. Server only, like likeness_consents: RLS on with no policies, no browser grants.
begin;

-- Lets a persona name its consent together with the workspace, so the two can never belong to different ones.
alter table public.likeness_consents add constraint likeness_consents_id_org unique (id, org_id);

create table public.personas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  description text not null default '' check (length(description) <= 1000),
  language text not null default 'en' check (language in ('en','el')),
  consent_id uuid unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  -- Erasing the person's consent (their account was deleted) empties the link and keeps the persona.
  foreign key (consent_id, org_id) references public.likeness_consents(id, org_id) on delete set null (consent_id)
);
create index personas_org on public.personas(org_id, created_at desc);

create table public.persona_looks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  persona_id uuid not null,
  name text not null check (length(name) between 1 and 80),
  description text not null default '' check (length(description) <= 1000),
  image_key text check (image_key is null or length(image_key) <= 512),
  position integer not null default 0 check (position >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (persona_id, org_id) references public.personas(id, org_id) on delete cascade
);
create index persona_looks_persona on public.persona_looks(persona_id, position, created_at);

alter table public.personas enable row level security;
alter table public.persona_looks enable row level security;
revoke all on public.personas from anon, authenticated;
revoke all on public.persona_looks from anon, authenticated;

commit;
