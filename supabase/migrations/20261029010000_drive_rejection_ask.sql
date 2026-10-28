-- Cooldown stamp for "still applied?" Telegram asks when a drive disappears from getAppliedEvents.

alter table public.drive
  add column if not exists last_rejection_ask_at timestamptz;
