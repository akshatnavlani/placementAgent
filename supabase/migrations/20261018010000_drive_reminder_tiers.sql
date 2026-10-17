-- Multi-tier deadline reminders (12h / 6h / 3h / 1h / 30m).

alter table public.drive
  add column if not exists reminder_tiers_sent jsonb not null default '[]'::jsonb;
