-- M9: draft rows written by /draft/callback after Cursor Prepare.

create table if not exists public.draft (
  id uuid primary key default gen_random_uuid(),
  drive_id text not null,
  status text not null check (status in ('pending', 'ready', 'failed')),
  latex text,
  answers jsonb not null default '[]'::jsonb,
  error text,
  callback_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists draft_drive_id_created_at_idx
  on public.draft (drive_id, created_at desc);

alter table public.draft enable row level security;

grant select, insert, update, delete on table public.draft to service_role;
