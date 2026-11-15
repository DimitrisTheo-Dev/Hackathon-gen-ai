-- Persona voices: the voices a persona speaks with (supabase/migrations/20261115130000_personas.sql).
--
-- A voice is one connection to a speech service that can say a script in the persona's voice:
--   • cartesia, elevenlabs: a clone stored at the vendor, called on its own API (provider_voice_id).
--   • fal: a model on fal.ai (model holds the endpoint id). Either a clone stored there (MiniMax voice clone,
--     provider_voice_id) or a model that clones from a reference clip on every request (HeyGen Voice,
--     reference_audio_key).
--
-- Fallbacks: priority orders the voices the engine tries. The lowest priority is the persona's default voice; when
-- its service fails (down, out of credit, refused), the engine tries the next priority, and so on. A voice with no
-- priority is never picked automatically, only when someone chooses it. Every fallback should be the same person's
-- voice: a stock voice is never a fallback for a persona.
--
-- Every voice is covered by the persona's consent (likeness_consents covers face and voice), so a persona without a
-- live consent cannot speak either. Reference clips live in the private R2 bucket under orgs/<org>/personas/<persona>/,
-- next to the look photos; the column holds the key, never a URL. Deleting a persona deletes its voices and their
-- clips (packages/engine/src/personas.ts). Deleting the clone at the vendor is a separate step.
--
-- Additive only. Server only, like personas: RLS on with no policies, no browser grants.
begin;

create table public.persona_voices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  persona_id uuid not null,
  name text not null check (length(name) between 1 and 80),
  provider text not null check (provider in ('cartesia', 'elevenlabs', 'fal')),
  -- The vendor model or fal endpoint, e.g. sonic-3.6, eleven_v4, heygen/heygen-voice, fal-ai/minimax/speech-2.8-hd.
  model text not null check (length(model) between 1 and 120),
  -- The clone's id at the vendor, for voices stored there.
  provider_voice_id text check (provider_voice_id is null or length(provider_voice_id) between 1 and 200),
  -- The reference clip in R2, for models that clone on every request.
  reference_audio_key text check (reference_audio_key is null or length(reference_audio_key) <= 512),
  language text not null default 'en' check (language in ('en', 'el')),
  -- Options the voice is rendered with (speed, emotion, language_boost, expressiveness_boost). Never secrets.
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  -- 1 is the default voice, 2 the first fallback, and so on. Null: only used when chosen by hand.
  priority smallint check (priority is null or priority between 1 and 20),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (provider_voice_id is not null or reference_audio_key is not null),
  foreign key (persona_id, org_id) references public.personas(id, org_id) on delete cascade
);
create index persona_voices_persona on public.persona_voices(persona_id, priority, created_at);
-- One voice per step of the fallback order.
create unique index persona_voices_priority on public.persona_voices(persona_id, priority) where priority is not null;
-- The same stored clone is connected once per persona.
create unique index persona_voices_provider_voice on public.persona_voices(persona_id, provider, model, provider_voice_id) where provider_voice_id is not null;

alter table public.persona_voices enable row level security;
revoke all on public.persona_voices from anon, authenticated;
comment on table public.persona_voices is 'Voices a persona speaks with, in fallback order (priority 1 is the default): a vendor clone id or an R2 reference clip. Covered by the persona''s consent. Written only by the engine with the server secret key.';

commit;
