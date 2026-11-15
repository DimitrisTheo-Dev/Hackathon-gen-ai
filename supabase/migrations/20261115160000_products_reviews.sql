-- Brand kit products and content reviews (packages/engine/src/products.ts, review.ts; contract: packages/contracts/src/quality.ts).
--
-- A product is part of the workspace brand kit: a name, a short description, the facts the brand has approved
-- (the only product claims a script may make without a source) and an optional photo. `domain` marks products
-- whose scripts are regulated: a script that names a health or finance product needs a named human approval
-- before it can be scheduled. Photos live in the private R2 bucket under orgs/<org>/products/; the column holds
-- the key, never a URL.
--
-- A content review records what was checked for one revision of one item: claims in the script, the timeline's
-- spoken words, captions and labels, and visuals. It never says "verified". `item_revision` binds it to the
-- script it describes; a newer revision makes it stale. `approval` is the named human approval (owner, admin or
-- reviewer) with their qualification and note, and is null until given. Rows are written by the engine only.
--
-- Additive only. Server only, like personas: RLS on with no policies, no browser grants.
begin;

create table public.brand_products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  description text not null default '' check (length(description) <= 300),
  domain text not null default 'general' check (domain in ('general','health','finance')),
  facts jsonb not null default '[]' check (jsonb_typeof(facts) = 'array' and jsonb_array_length(facts) <= 12),
  image_key text check (image_key is null or (length(image_key) <= 512 and image_key like 'orgs/' || org_id::text || '/products/%')),
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index brand_products_org on public.brand_products(org_id, position, created_at);
-- One product per stored photo, so replacing or deleting one product's photo never breaks another's.
create unique index brand_products_image_key on public.brand_products(image_key) where image_key is not null;

create table public.content_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  item_id uuid not null references public.content_items(id) on delete cascade,
  item_revision integer not null check (item_revision > 0),
  composition_revision integer check (composition_revision is null or composition_revision >= 0),
  domain text not null check (domain in ('general','health','finance')),
  mode text not null check (mode in ('ai','basic')),
  status text not null check (status in ('passed','needs_changes','needs_approval','approved')),
  claims jsonb not null default '[]' check (jsonb_typeof(claims) = 'array'),
  findings jsonb not null default '[]' check (jsonb_typeof(findings) = 'array'),
  checked jsonb not null check (jsonb_typeof(checked) = 'object'),
  notes jsonb not null default '[]' check (jsonb_typeof(notes) = 'array'),
  approval jsonb check (approval is null or jsonb_typeof(approval) = 'object'),
  -- An approved review always names its approval, and an approval always makes the review approved.
  check ((status = 'approved') = (approval is not null)),
  created_by text not null,
  created_at timestamptz not null default now()
);
-- The latest review of an item (GET /v1/studio/items/:id/review, the schedule gate).
create index content_reviews_item on public.content_reviews(org_id, item_id, created_at desc);
-- Foreign-key lookups when a project or item is deleted.
create index content_reviews_project on public.content_reviews(project_id);
create index content_reviews_item_fk on public.content_reviews(item_id);

alter table public.brand_products enable row level security;
alter table public.content_reviews enable row level security;
revoke all on public.brand_products from anon, authenticated;
revoke all on public.content_reviews from anon, authenticated;

commit;
