-- Application data is reachable only through the service role, which the Render watcher uses.
-- The anon and authenticated roles (the public API keys) get nothing in public,
-- including tables and functions created by later migrations.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public;

-- One student, so one row per table.

create table public.profile (
  id smallint primary key default 1 check (id = 1),
  student_id text not null,
  -- Latest platform snapshot (studentData). Holds phone and DOB, which never go to the drafter.
  platform jsonb not null,
  platform_synced_at timestamptz not null,
  -- Facts typed in by the student. A platform sync never writes this column.
  manual jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.secret (
  id smallint primary key default 1 check (id = 1),
  -- Placement bearer token. The password is never stored; it stays in Render's environment.
  bearer_token text,
  token_obtained_at timestamptz,
  token_source text check (token_source in ('validatestudent', 'verifyOtp')),
  updated_at timestamptz not null default now()
);

alter table public.profile enable row level security;
alter table public.secret enable row level security;

grant select, insert, update, delete on table public.profile, public.secret to service_role;
