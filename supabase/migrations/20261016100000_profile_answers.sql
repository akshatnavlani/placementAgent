-- M8: canonical LaTeX + onboarding state on profile; answer bank.

alter table public.profile
  add column if not exists canonical_latex text,
  add column if not exists canonical_latex_updated_at timestamptz,
  add column if not exists onboarding jsonb not null default '{}'::jsonb;

create table if not exists public.answer (
  id uuid primary key default gen_random_uuid(),
  label_normalized text not null,
  label_display text not null,
  value text not null,
  approved boolean not null default false,
  reusable boolean not null default true,
  drive_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One global reusable answer per normalized label.
create unique index if not exists answer_reusable_global_label_uidx
  on public.answer (label_normalized)
  where reusable = true and drive_id is null;

alter table public.answer enable row level security;

grant select, insert, update, delete on table public.answer to service_role;
