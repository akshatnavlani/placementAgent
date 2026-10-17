-- Cron poll Telegram heartbeat reports (on by default).

alter table public.secret
  add column if not exists poll_reports_enabled boolean not null default true;
