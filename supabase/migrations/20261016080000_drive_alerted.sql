-- Dedup Telegram alerts across restarts. Backfill so the current catalog is not re-spammed.

alter table public.drive
  add column alerted_at timestamptz;

update public.drive
set alerted_at = first_seen_at
where alerted_at is null;
