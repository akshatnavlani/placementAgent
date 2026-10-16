-- M10: track Telegram delivery of ready drafts.

alter table public.draft
  add column if not exists delivered_at timestamptz;
