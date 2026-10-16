-- M5: session renewal waiting / OTP window on the singleton secret row.

alter table public.secret
  add column if not exists login_wait_state text
    check (login_wait_state is null or login_wait_state in ('awaiting_approval', 'awaiting_otp')),
  add column if not exists login_wait_notified_at timestamptz,
  add column if not exists otp_sent_at timestamptz,
  add column if not exists otp_paste_prompted_at timestamptz;
