-- Catalog drives keyed by top-level event _id. Service role only (watcher).

create table public.drive (
  id text primary key,
  raw_list jsonb not null,
  raw_detail jsonb,
  updated_at_platform timestamptz,
  is_eligible boolean,
  deadline timestamptz,
  status text check (status in (
    'New', 'Applied', 'Assessment', 'Interview',
    'Accepted', 'Rejected', 'Not Applied'
  )),
  reminder_sent boolean not null default false,
  draft_status text check (draft_status in ('pending', 'ready', 'failed')),
  notion_page_id text,
  pdf_urls jsonb not null default '[]'::jsonb,
  pdf_text jsonb not null default '{}'::jsonb,
  company_id text,
  company_name text,
  company_username text,
  event_name text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.drive enable row level security;

grant select, insert, update, delete on table public.drive to service_role;
