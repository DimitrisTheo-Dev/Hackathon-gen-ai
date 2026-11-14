/**
 * Applies the engine migration to a throwaway LOCAL Postgres database and checks its guarantees:
 * atomic/replay-safe credit holds with no overdraft; members read only their own organization;
 * browsers cannot write; ledgers, tokens and billing are server-only; anonymous access is denied.
 *   node scripts/test-engine-rls.mjs      (needs a local `psql` that can create databases)
 */
import { execFileSync } from 'node:child_process';
const database = `faceful_engine_test_${Date.now()}`;
const run = (db, sql) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db], { input: sql, encoding: 'utf8' });
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222';
try {
  run('postgres', `create database ${database};`);
  run(database, `
do $$begin
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role; end if;
end$$;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
\\i supabase/migrations/20261114190000_engine_core.sql
insert into auth.users values ('${U1}'),('${U2}');
insert into public.organizations(id,name) values ('${A}','A'),('${B}','B');
insert into public.memberships values ('${A}','${U1}','owner'),('${B}','${U2}','owner');
insert into public.projects(org_id,title,timezone) values ('${A}','A project','Europe/Athens'),('${B}','B project','Europe/Athens');
insert into public.credit_ledger(org_id,delta,reason,ref) values ('${A}',2,'starter_grant','starter');
do $$begin
  if public.engine_hold_credits('${A}',1,'render:1')<>1 then raise exception 'first hold';end if;
  if public.engine_hold_credits('${A}',1,'render:1')<>1 then raise exception 'a replayed hold must be a no-op';end if;
  if public.engine_hold_credits('${A}',1,'render:2')<>0 then raise exception 'second hold';end if;
  if public.engine_hold_credits('${A}',1,'render:3') is not null then raise exception 'overdraft accepted';end if;
end$$;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','${U1}',true);
do $$begin
  if (select count(*) from public.projects)<>1 then raise exception 'member must see exactly their own organization''s projects';end if;
  if (select count(*) from public.organizations)<>1 then raise exception 'organization leak';end if;
  begin insert into public.projects(org_id,title,timezone) values('${A}','x','UTC');raise exception 'browser insert accepted';exception when insufficient_privilege then null;end;
  begin update public.projects set title='hacked';raise exception 'browser update accepted';exception when insufficient_privilege then null;end;
  begin perform count(*) from public.credit_ledger;raise exception 'credit ledger readable';exception when insufficient_privilege then null;end;
  begin perform count(*) from public.agent_connections;raise exception 'agent tokens readable';exception when insufficient_privilege then null;end;
  begin perform count(*) from public.billing_state;raise exception 'billing readable';exception when insufficient_privilege then null;end;
  begin perform count(*) from public.stripe_events;raise exception 'stripe events readable';exception when insufficient_privilege then null;end;
  begin perform public.engine_hold_credits('${A}',1,'x');raise exception 'browser can hold credits';exception when insufficient_privilege then null;end;
end$$;
rollback;
begin; set local role anon;
do $$begin begin perform count(*) from public.projects;raise exception 'anonymous read accepted';exception when insufficient_privilege then null;end;end$$;
rollback;`);
  console.log('PASS: migration applies; credit hold is atomic, replay-safe and cannot overdraw; members read only their organization; no browser writes; ledgers, tokens, billing and Stripe events are server-only; anonymous access denied.');
} finally { run('postgres', `drop database if exists ${database};`); }
