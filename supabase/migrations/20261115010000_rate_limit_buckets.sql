-- Cross-instance request rate limiting for /v1 and /mcp. Additive only: no existing object is altered or dropped.
-- The engine calls engine_rate_limit_hit() with the server secret key on every limited request; browsers have
-- no access to the table or the function. See packages/engine/src/ratelimit.ts and SECURITY.md.
begin;

-- Fixed-window counters. UNLOGGED on purpose: counters are ephemeral, so they skip the WAL; after a database
-- crash the table is emptied and every window simply starts again.
create unlogged table public.rate_limit_buckets (
  key text not null check (length(key) between 1 and 200),
  window_start timestamptz not null,
  hits integer not null check (hits >= 0),
  expires_at timestamptz not null,
  primary key (key, window_start)
);
-- Housekeeping reads expired rows oldest-first.
create index rate_limit_buckets_expires on public.rate_limit_buckets (expires_at);

-- RLS on with no policies, and no table privileges for any API role: only the function below touches it.
alter table public.rate_limit_buckets enable row level security;
revoke all on public.rate_limit_buckets from public, anon, authenticated, service_role;
comment on table public.rate_limit_buckets is 'Request counters per (policy:subject, window). Keys hold opaque principal IDs or a SHA-256 of the client network, never raw IPs or tokens. Written only by engine_rate_limit_hit().';

-- Atomically counts one request (or `p_cost` requests) against `p_key` in the current window and says whether
-- it fits in `p_limit`. Concurrent callers serialize on the bucket row through INSERT ... ON CONFLICT, so the
-- count is exact across function instances. The window comes from the database clock, not the caller's.
create or replace function public.engine_rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer, p_cost integer default 1)
returns table (allowed boolean, remaining integer, reset_seconds integer)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  v_start timestamptz;
  v_end timestamptz;
  v_hits integer;
begin
  if p_key is null or length(p_key) not between 1 and 200 then raise exception 'p_key must be 1 to 200 characters' using errcode = '22023'; end if;
  if p_limit is null or p_limit not between 1 and 1000000 then raise exception 'p_limit must be between 1 and 1000000' using errcode = '22023'; end if;
  if p_window_seconds is null or p_window_seconds not between 1 and 86400 then raise exception 'p_window_seconds must be between 1 and 86400' using errcode = '22023'; end if;
  if p_cost is null or p_cost not between 1 and 1000 then raise exception 'p_cost must be between 1 and 1000' using errcode = '22023'; end if;

  v_start := to_timestamp((floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds)::double precision);
  v_end := v_start + make_interval(secs => p_window_seconds);

  insert into public.rate_limit_buckets as b (key, window_start, hits, expires_at)
  values (p_key, v_start, p_cost, v_end)
  on conflict (key, window_start) do update set hits = least(b.hits::bigint + excluded.hits, 2000000000)::integer
  returning b.hits into v_hits;

  -- Bounded housekeeping: every call removes up to 20 expired buckets. A call creates at most one bucket, so the
  -- table cannot grow without bound, and SKIP LOCKED means cleanup never waits on a concurrent caller.
  delete from public.rate_limit_buckets d
  using (
    select s.key, s.window_start from public.rate_limit_buckets s
    where s.expires_at < v_now
    order by s.expires_at
    limit 20
    for update skip locked
  ) expired
  where d.key = expired.key and d.window_start = expired.window_start;

  allowed := v_hits <= p_limit;
  remaining := greatest(p_limit - v_hits, 0);
  reset_seconds := greatest(ceil(extract(epoch from (v_end - v_now)))::integer, 0);
  return next;
end $$;
revoke all on function public.engine_rate_limit_hit(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.engine_rate_limit_hit(text, integer, integer, integer) to service_role;
comment on function public.engine_rate_limit_hit(text, integer, integer, integer) is 'Fixed-window rate limiter for the Faceful engine. service_role only.';

commit;
