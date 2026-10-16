-- M11: recruitment mail rows + Gmail history cursors.

create table if not exists public.mail (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null,
  gmail_thread_id text,
  account text not null check (account in ('pesu', 'personal')),
  drive_id text,
  classification text not null check (
    classification in (
      'shortlist_present',
      'shortlist_absent',
      'assessment',
      'interview',
      'rejection',
      'offer_received',
      'offer_accepted',
      'offer_confirmed',
      'reschedule',
      'cancel',
      'unresolved'
    )
  ),
  confidence text not null check (confidence in ('high', 'low')),
  subject text not null default '',
  snippet text not null default '',
  classified_at timestamptz not null default now(),
  notified_at timestamptz,
  raw_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account, gmail_message_id)
);

create index if not exists mail_drive_id_classified_at_idx
  on public.mail (drive_id, classified_at desc);

alter table public.mail enable row level security;
grant select, insert, update, delete on table public.mail to service_role;

create table if not exists public.mail_sync (
  account text primary key check (account in ('pesu', 'personal')),
  history_id text,
  updated_at timestamptz not null default now()
);

alter table public.mail_sync enable row level security;
grant select, insert, update, delete on table public.mail_sync to service_role;
