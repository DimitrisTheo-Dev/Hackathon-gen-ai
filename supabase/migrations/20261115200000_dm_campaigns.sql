-- Comment-to-DM campaigns (packages/engine/src/socials-campaigns.ts).
--
-- Someone comments a campaign's keyword under a post; the account answers them privately with the campaign's
-- message. When they write back, an AI model can carry the conversation and the campaign's follow-ups (a message,
-- a link) go out on their schedule, inside the 24 hours Instagram allows after each of their messages.
--
--   dm_campaigns      what to listen for on which account, and what to say
--   dm_conversations  one per person per account: where the conversation stands
--   dm_messages       everything said both ways, including what is scheduled and what a test only simulated
--
-- Server only, like social_events: RLS is on and browsers have no grants. Messages are private.
begin;

create table public.dm_campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  account_id uuid not null references public.provider_connections(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  enabled boolean not null default false,
  -- Whole words or phrases, matched without regard to case or accents.
  keywords text[] not null check (cardinality(keywords) between 1 and 10),
  opening_message text not null check (length(opening_message) between 1 and 1000),
  link_url text check (link_url is null or (length(link_url) <= 2000 and link_url ~ '^https://')),
  public_reply text check (public_reply is null or length(public_reply) between 1 and 300),
  ai_enabled boolean not null default false,
  ai_instructions text check (ai_instructions is null or length(ai_instructions) <= 4000),
  -- [{ "delayMinutes": 60, "text": "..." }], at most three, each within the 24-hour window.
  follow_ups jsonb not null default '[]' check (jsonb_typeof(follow_ups) = 'array'),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index dm_campaigns_org on public.dm_campaigns(org_id, created_at);
create index dm_campaigns_listening on public.dm_campaigns(account_id) where enabled;

create table public.dm_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  account_id uuid not null references public.provider_connections(id) on delete cascade,
  campaign_id uuid references public.dm_campaigns(id) on delete set null,
  -- The person as their messages name them (Instagram's IGSID, learned from the first private reply), and as their comment did.
  contact_id text not null check (length(contact_id) between 1 and 200),
  commenter_id text check (commenter_id is null or length(commenter_id) <= 200),
  contact_name text check (contact_name is null or length(contact_name) <= 200),
  comment_id text check (comment_id is null or length(comment_id) <= 500),
  state text not null check (state in ('awaiting_reply', 'open', 'stopped')),
  -- A conversation made by "Try it" in Settings: nothing in it was sent to anyone.
  simulated boolean not null default false,
  ai_turns integer not null default 0 check (ai_turns >= 0),
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, account_id, contact_id)
);
create index dm_conversations_campaign on public.dm_conversations(campaign_id, updated_at desc);
create index dm_conversations_commenter on public.dm_conversations(account_id, commenter_id);

create table public.dm_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.dm_conversations(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  -- in: the comment, then their messages. out: the opening message, the public reply, AI answers, follow-ups, notices.
  kind text not null check (kind in ('comment', 'message', 'opening', 'public_reply', 'ai', 'follow_up', 'notice')),
  text text not null check (length(text) <= 5000),
  status text not null check (status in ('received', 'scheduled', 'sending', 'sent', 'failed', 'skipped', 'cancelled', 'simulated')),
  send_at timestamptz,
  sent_at timestamptz,
  external_id text check (external_id is null or length(external_id) <= 500),
  error text check (error is null or length(error) <= 500),
  created_at timestamptz not null default now()
);
create index dm_messages_conversation on public.dm_messages(conversation_id, created_at);
create index dm_messages_due on public.dm_messages(send_at) where status = 'scheduled';

alter table public.dm_campaigns enable row level security;
alter table public.dm_conversations enable row level security;
alter table public.dm_messages enable row level security;
revoke all on public.dm_campaigns, public.dm_conversations, public.dm_messages from anon, authenticated;

commit;
