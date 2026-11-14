/**
 * Applies the engine migrations to a throwaway LOCAL Postgres database and checks their guarantees:
 * atomic/replay-safe credit holds with no overdraft; members read only their own organization;
 * browsers cannot write; ledgers, tokens and billing are server-only; anonymous access is denied;
 * the rate limiter counts exactly under concurrency, cleans up after itself and is service_role-only.
 *   node scripts/test-engine-rls.mjs      (needs a local `psql` that can create databases)
 */
import { execFileSync, spawn } from 'node:child_process';
const database = `faceful_engine_test_${Date.now()}`;
const run = (db, sql) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db], { input: sql, encoding: 'utf8' });
/** One psql session per call, so concurrent calls are genuinely concurrent database sessions. */
const runAsync = (db, sql) => new Promise((resolve, reject) => {
  const child = spawn('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db]);
  let out = '', err = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (err += chunk));
  child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `psql exited ${code}`))));
  child.stdin.end(sql);
});
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
\\i supabase/migrations/20261115010000_rate_limit_buckets.sql
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
  begin perform count(*) from public.rate_limit_buckets;raise exception 'rate limit buckets readable by members';exception when insufficient_privilege then null;end;
  begin perform public.engine_rate_limit_hit('x',1,60);raise exception 'browser can call the rate limiter';exception when insufficient_privilege then null;end;
end$$;
rollback;
begin; set local role anon;
do $$begin
  begin perform count(*) from public.projects;raise exception 'anonymous read accepted';exception when insufficient_privilege then null;end;
  begin perform count(*) from public.rate_limit_buckets;raise exception 'anonymous rate limit read accepted';exception when insufficient_privilege then null;end;
  begin perform public.engine_rate_limit_hit('x',1,60);raise exception 'anonymous rate limiter call accepted';exception when insufficient_privilege then null;end;
end$$;
rollback;

-- Rate limiter: semantics, grants, RLS, housekeeping and argument checks.
do $$
declare r record;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.rate_limit_buckets'::regclass) then raise exception 'RLS must be enabled on rate_limit_buckets'; end if;
  if (select relpersistence from pg_class where oid = 'public.rate_limit_buckets'::regclass) <> 'u' then raise exception 'rate_limit_buckets should be unlogged'; end if;
  if (select count(*) from pg_policies where tablename = 'rate_limit_buckets') <> 0 then raise exception 'rate_limit_buckets must have no policies'; end if;
  if has_function_privilege('public', 'public.engine_rate_limit_hit(text,integer,integer,integer)', 'execute') then raise exception 'PUBLIC can execute the limiter'; end if;
  if not has_function_privilege('service_role', 'public.engine_rate_limit_hit(text,integer,integer,integer)', 'execute') then raise exception 'service_role cannot execute the limiter'; end if;
  if (select prosecdef from pg_proc where oid = 'public.engine_rate_limit_hit(text,integer,integer,integer)'::regprocedure) is not true then raise exception 'limiter must be security definer'; end if;
  if not exists (select 1 from pg_proc where oid = 'public.engine_rate_limit_hit(text,integer,integer,integer)'::regprocedure and proconfig @> array['search_path=""']) then raise exception 'limiter must pin search_path'; end if;
end$$;
begin;
set local role service_role;
do $$
declare r record; i integer;
begin
  -- limit 3: allowed, allowed, allowed, refused; remaining counts down; reset is within the window.
  for i in 1..4 loop
    select * into r from public.engine_rate_limit_hit('principal:user:a', 3, 60);
    if r.allowed <> (i <= 3) then raise exception 'hit % allowed=% (expected %)', i, r.allowed, i <= 3; end if;
    if r.remaining <> greatest(3 - i, 0) then raise exception 'hit % remaining=%', i, r.remaining; end if;
    if r.reset_seconds not between 0 and 60 then raise exception 'reset_seconds out of range: %', r.reset_seconds; end if;
  end loop;
  select * into r from public.engine_rate_limit_hit('principal:user:b', 3, 60);
  if not r.allowed or r.remaining <> 2 then raise exception 'keys must be independent'; end if;
  select * into r from public.engine_rate_limit_hit('principal:user:c', 10, 60, 7);
  if r.remaining <> 3 then raise exception 'cost must count several requests'; end if;
  -- Argument checks.
  begin perform public.engine_rate_limit_hit('', 1, 60); raise exception 'empty key accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.engine_rate_limit_hit(repeat('k', 201), 1, 60); raise exception 'long key accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.engine_rate_limit_hit('k', 0, 60); raise exception 'zero limit accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.engine_rate_limit_hit('k', 1, 0); raise exception 'zero window accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.engine_rate_limit_hit('k', 1, 60, 0); raise exception 'zero cost accepted'; exception when invalid_parameter_value then null; end;
  begin perform count(*) from public.rate_limit_buckets; raise exception 'service_role must not read the table directly'; exception when insufficient_privilege then null; end;
end$$;
rollback;
-- Housekeeping: 45 expired buckets are removed at most 20 per call, without touching live ones.
insert into public.rate_limit_buckets(key, window_start, hits, expires_at)
select 'old:' || g, now() - interval '2 hours', 1, now() - interval '1 hour' from generate_series(1, 45) g;
begin; set local role service_role; select public.engine_rate_limit_hit('housekeeping', 5, 60); commit;
do $$begin if (select count(*) from public.rate_limit_buckets where key like 'old:%') <> 25 then raise exception 'one call must remove exactly 20 expired buckets'; end if; end$$;
begin; set local role service_role; select public.engine_rate_limit_hit('housekeeping', 5, 60); select public.engine_rate_limit_hit('housekeeping', 5, 60); commit;
do $$begin
  if exists (select 1 from public.rate_limit_buckets where key like 'old:%') then raise exception 'expired buckets must all be removed'; end if;
  if (select hits from public.rate_limit_buckets where key = 'housekeeping') <> 3 then raise exception 'the live bucket must be kept and counted'; end if;
end$$;`);

  // Atomicity: 8 concurrent sessions × 25 single-statement transactions against one key with limit 100.
  // Exactly 100 must be admitted and the bucket must hold all 200 hits — no lost update, no over-admission.
  const sessions = 8, perSession = 25, limit = 100;
  const script = `set role service_role;\n${Array.from({ length: perSession }, () => `select allowed from public.engine_rate_limit_hit('race:key', ${limit}, 86400);`).join('\n')}\n`;
  const outputs = await Promise.all(Array.from({ length: sessions }, () => runAsync(database, script)));
  const admitted = outputs.join('\n').split('\n').filter((line) => line.trim() === 't').length;
  const refused = outputs.join('\n').split('\n').filter((line) => line.trim() === 'f').length;
  const stored = Number(run(database, `\\pset tuples_only on\n\\pset format unaligned\nselect sum(hits) from public.rate_limit_buckets where key = 'race:key';`).trim());
  if (admitted !== limit || refused !== sessions * perSession - limit || stored !== sessions * perSession)
    throw new Error(`rate limiter is not atomic: admitted=${admitted} refused=${refused} stored=${stored}`);

  console.log(`PASS: migrations apply; credit hold is atomic, replay-safe and cannot overdraw; members read only their organization; no browser writes; ledgers, tokens, billing and Stripe events are server-only; anonymous access denied. Rate limiter: RLS on, unlogged, no policies, service_role-only security definer with pinned search_path; exact fixed-window semantics and argument checks; bounded cleanup of expired buckets; ${sessions} concurrent sessions × ${perSession} hits admitted exactly ${admitted}/${limit} and stored ${stored}.`);
} finally { run('postgres', `drop database if exists ${database};`); }
