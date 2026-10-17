# Claude Code routine setup (drafter)

The watcher does not create the routine. You create it once in Claude Code, then point Render at its API fire URL and token.

Cursor Automations remain supported if only `CURSOR_WEBHOOK_*` is set. When both Claude and Cursor env are set, the watcher prefers Claude Code.

## 1. Create the routine

1. Open [claude.ai/code/routines](https://claude.ai/code/routines) → **New routine** (Cloud).
2. Paste the contents of [`DRAFTER.md`](./DRAFTER.md) into the routine prompt. The prompt **must** tell Claude to read and act on the routine-fire-payload (see DRAFTER.md).
3. Attach this repo (or any repo you want the session to clone). Network access matters more than code for drafting.
4. Under the routine **environment**, allow outbound HTTPS to your watcher host (e.g. `pesu-placement-watcher.onrender.com`). The default Trusted allowlist will block Render; without this, payload fetch and callback fail.
5. Under **Select a trigger**, add **API**. Save the routine, then open the API trigger modal: copy the **fire URL** and **Generate token** (shown once).

## 2. Render env

On the watcher service (`pesu-placement-watcher`):

| Variable | Value |
|---|---|
| `CLAUDE_CODE_ROUTINE_FIRE_URL` | Full `…/routines/trig_…/fire` URL from step 1 |
| `CLAUDE_CODE_ROUTINE_TOKEN` | `sk-ant-oat01-…` token from step 1 |
| `DRAFT_CALLBACK_SECRET` | Shared secret (≥32) you invent once — Render only; mirrored into prepare payloads |
| `PUBLIC_BASE_URL` | `https://pesu-placement-watcher.onrender.com` |

Optional (legacy): `CURSOR_WEBHOOK_URL` / `CURSOR_WEBHOOK_SECRET` — ignored when Claude Code vars are set.

Redeploy after setting env. Local `.env` does not affect the live Telegram bot.

## 3. How a Prepare run works

1. Telegram **Prepare** → watcher stores the full prepare JSON on the pending `draft` row.
2. Watcher `POST`s a compact JSON pointer as routine `text` to the fire URL.
3. The routine `GET`s `/draft/prepare-payload?driveId=…` with Bearer `callbackSecret`.
4. The routine drafts, then `POST`s `/draft/callback` with the same Bearer.

## 4. Smoke

1. Ensure `/profile` has stored canonical LaTeX.
2. Tap **Prepare** on a drive alert.
3. If required questions lack answers, Telegram asks first; answer or `cancel`.
4. Expect “preparing.” then “Draft ready for …”, an answers list, a `.tex` file, and a PDF when compile works.
5. Optionally open the session URL returned by the fire API on claude.ai to watch the run.
6. Check Supabase `draft` row `status = ready`, `delivered_at` set, with latex + answers.
