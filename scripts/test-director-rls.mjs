import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const database=`castroom_director_test_${Date.now()}`;
const run=(db,sql)=>execFileSync('psql',['-X','-v','ON_ERROR_STOP=1','-d',db],{input:sql,encoding:'utf8'});
const migration=readFileSync('supabase/migrations/20261114151010_director_conversations.sql','utf8').replace(/^begin;|^commit;/gm,'');
try {
  run('postgres',`create database ${database};`);
  const output=run(database,`begin;
create role authenticated;
create role anon;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
${migration}
insert into auth.users values ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
insert into public.castroom_director_access values ('11111111-1111-4111-8111-111111111111','workspace-a','campaign-a'),('22222222-2222-4222-8222-222222222222','workspace-b','campaign-b');
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
insert into public.castroom_director_entries(id,entry_id,workspace_id,campaign_id,body) values ('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','workspace-a','campaign-a','{"instruction":"Test"}');
do $$begin
 if (select count(*) from public.castroom_director_entries)<>1 then raise exception 'Owner cannot read history';end if;
 begin insert into public.castroom_director_entries(id,entry_id,workspace_id,campaign_id,body) values(gen_random_uuid(),gen_random_uuid(),'workspace-b','campaign-b','{}');raise exception 'Wrong workspace accepted';exception when insufficient_privilege then null;end;
 begin insert into public.castroom_director_entries(id,entry_id,user_id,workspace_id,campaign_id,body) values(gen_random_uuid(),gen_random_uuid(),'22222222-2222-4222-8222-222222222222','workspace-b','campaign-b','{}');raise exception 'Forged actor accepted';exception when insufficient_privilege then null;end;
 begin update public.castroom_director_entries set body='{}';raise exception 'History overwrite accepted';exception when insufficient_privilege then null;end;
 begin insert into public.castroom_director_access values('11111111-1111-4111-8111-111111111111','workspace-b','campaign-b');raise exception 'Self grant accepted';exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$begin if (select count(*) from public.castroom_director_entries)<>0 then raise exception 'Cross-user read leaked';end if;end$$;
reset role;
delete from public.castroom_director_access where workspace_id='workspace-a';
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$begin
 if (select count(*) from public.castroom_director_entries)<>0 then raise exception 'Revoked history leaked';end if;
 begin insert into public.castroom_director_entries(id,entry_id,workspace_id,campaign_id,body) values(gen_random_uuid(),gen_random_uuid(),'workspace-a','campaign-a','{}');raise exception 'Revoked write accepted';exception when insufficient_privilege then null;end;
end$$;
reset role;
set local role anon;
do $$begin begin perform count(*) from public.castroom_director_entries;raise exception 'Anonymous read accepted';exception when insufficient_privilege then null;end;end$$;
rollback;
`);
  console.log('PASS: owner read/write; denied wrong workspace, forged actor, overwrite, self-grant, cross-user read, revoked read/write and anonymous read. Transaction rolled back.\n'+output);
} finally { run('postgres',`drop database if exists ${database};`); }
