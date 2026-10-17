-- Store full Prepare payload for Claude Code routine fire (65k text limit).

alter table public.draft
  add column if not exists request_payload jsonb;
