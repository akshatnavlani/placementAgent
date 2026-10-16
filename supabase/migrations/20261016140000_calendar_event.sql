-- M12: Google Calendar event rows + placements calendar id sync.

create table if not exists public.calendar_sync (
  id text primary key default 'personal',
  google_calendar_id text not null,
  calendar_summary text not null default 'placements',
  updated_at timestamptz not null default now()
);

alter table public.calendar_sync enable row level security;
grant select, insert, update, delete on table public.calendar_sync to service_role;

create table if not exists public.calendar_event (
  id uuid primary key default gen_random_uuid(),
  drive_id text not null,
  round_key text not null check (round_key in ('assessment', 'interview')),
  google_event_id text not null,
  source text not null check (source in ('mail', 'subevent')),
  status text not null default 'active' check (status in ('active', 'cancelled')),
  start_at timestamptz,
  end_at timestamptz,
  title text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (drive_id, round_key)
);

create index if not exists calendar_event_drive_id_idx
  on public.calendar_event (drive_id);

alter table public.calendar_event enable row level security;
grant select, insert, update, delete on table public.calendar_event to service_role;
