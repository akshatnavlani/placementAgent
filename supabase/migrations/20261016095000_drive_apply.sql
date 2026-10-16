-- M6: apply verification timestamps on drive.

alter table public.drive
  add column if not exists applied_at timestamptz,
  add column if not exists last_apply_check_at timestamptz;
