# PESU Placement Automation

A personal automation that watches the PESU placement catalog, alerts eligible drives on Telegram, and mirrors them to a Notion board.

- What it is and the decisions behind it: [docs/source-of-truth.md](docs/source-of-truth.md)
- Build order and milestone gates: [docs/implementation-plan.md](docs/implementation-plan.md)

## Run locally

Requires Node.js 24.

```bash
npm ci
cp .env.example .env   # set CRON_SHARED_SECRET to at least 32 random characters
npm run dev
```

`GET /health` is public. `POST /cron/poll` requires `Authorization: Bearer <CRON_SHARED_SECRET>`.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

## Deploy

The Render free web service `pesu-placement-watcher` builds the `deploy` branch with `npm ci --include=dev && npm run build` and starts with `npm start`. Secrets live only in the Render environment and a local, gitignored `.env`.

## Database

SQL migrations live in `supabase/migrations/` and are applied in filename order.
