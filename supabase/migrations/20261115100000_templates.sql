-- Video template library: the short-form templates built with OpenMontage (templates/ in the content-creator
-- repository: five with a presenter, five without a face). Additive only: no existing object is altered or dropped.
-- Rows are first-party catalog entries, written with the server secret key by templates/_kit/publish.mjs. Sample
-- media lives in the private `media` bucket under templates/<id>/; the API hands out short-lived signed URLs, so
-- the paths below are never public links.
begin;

create table public.templates (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  version integer not null default 1 check (version > 0),
  family text not null check (family in ('face', 'no_face')),
  name text not null check (length(name) between 1 and 80),
  summary text not null check (length(summary) between 1 and 400),
  use_for text not null check (length(use_for) between 1 and 400),
  position integer not null default 0,
  published boolean not null default false,
  -- What a sample is: its language and topic, and the range a new video made from the template should stay in.
  language text not null default 'el',
  languages text[] not null default '{el}',
  aspect_ratio text not null default '9:16' check (aspect_ratio = '9:16'),
  fps integer not null default 25 check (fps between 1 and 60),
  duration_min integer not null check (duration_min > 0),
  duration_max integer not null check (duration_max >= duration_min),
  sample_topic text not null,
  sample_seconds numeric(6, 2) not null check (sample_seconds > 0),
  voice text not null,
  fonts text[] not null default '{}',
  -- [{key, label}]: the per-beat fields a new video needs. [{id, text}]: the sample's lines as shown on screen.
  inputs jsonb not null default '[]' check (jsonb_typeof(inputs) = 'array'),
  script jsonb not null default '[]' check (jsonb_typeof(script) = 'array'),
  -- The full spec.json the sample was rendered from (the template's parameters, filled in).
  spec jsonb not null check (jsonb_typeof(spec) = 'object'),
  -- Storage paths in the `media` bucket. stills: [{beat, path}]; variants: [{language, path}].
  video_path text not null check (video_path like 'templates/%'),
  poster_path text not null check (poster_path like 'templates/%'),
  stills jsonb not null default '[]' check (jsonb_typeof(stills) = 'array'),
  variants jsonb not null default '[]' check (jsonb_typeof(variants) = 'array'),
  -- Measured on the sample: loudness, true peak, resolution, frame rate.
  qa jsonb not null default '{}' check (jsonb_typeof(qa) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index templates_published on public.templates (published, position);

-- The catalog holds no tenant data. RLS on; signed-in people may read published rows; only the server writes.
alter table public.templates enable row level security;
revoke all on public.templates from anon, authenticated;
grant select on public.templates to authenticated;
create policy templates_published_read on public.templates for select to authenticated using (published);
comment on table public.templates is 'First-party video template library (OpenMontage). Written only with the server secret key; media paths point into the private media bucket and are signed by the API.';

commit;
