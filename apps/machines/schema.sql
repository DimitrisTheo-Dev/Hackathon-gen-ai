-- Faceful machines database (Cloudflare D1: faceful-machines).
-- Compute and workspace state only. Content (briefs, scripts, reel timelines) stays in the engine's
-- Supabase database; rows here point at it by the same user id and project id.
-- Apply: npx wrangler d1 execute faceful-machines --remote --file schema.sql

create table if not exists machines (
  user_id text primary key,
  state text not null default 'stopped' check (state in ('starting', 'running', 'stopped', 'failed')),
  instance_type text not null,
  identity text not null default 'token' check (identity in ('token', 'session')),
  claude_signed_in integer not null default 0,
  starts integer not null default 0,
  last_started_at text,
  last_stopped_at text,
  last_seen_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists projects (
  user_id text not null,
  id text not null,                  -- an engine project UUID, or a slug for a scratch project
  title text not null,
  session_id text,                   -- the Claude Code conversation to resume
  runs integer not null default 0,
  last_run_at text,
  last_saved_at text,
  autosave_key text,
  autosave_bytes integer,
  autosave_files integer,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (user_id, id)
);

-- One row per object in the user's R2 folder. The autosave row is updated in place; manual saves append.
create table if not exists saves (
  user_id text not null,
  r2_key text not null,
  project_id text not null,
  kind text not null check (kind in ('auto', 'manual')),
  bytes integer not null,
  files integer not null,
  sha256 text not null,
  saved_at text not null,
  primary key (user_id, r2_key)
);
create index if not exists saves_by_project on saves (user_id, project_id, saved_at desc);

-- One row per wake, for the per-user limits (MACHINE_WAKES_PER_HOUR, MACHINE_AWAKE_MINUTES_PER_DAY).
-- stopped_at is null while the machine is awake. Rows older than a week are pruned on the next wake.
create table if not exists machine_wakes (
  user_id text not null,
  started_at text not null,
  stopped_at text
);
create index if not exists machine_wakes_by_user on machine_wakes (user_id, started_at desc);
