-- Stamp when GitHub Actions / cron last hit /cron/poll (for /pollreports status).

alter table public.secret
  add column if not exists last_cron_at timestamptz;
