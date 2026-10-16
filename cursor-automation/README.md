# Cursor automation setup (M9)

The watcher does not create the automation. You create it once in Cursor, then point Render at its webhook URL.

## 1. Create the automation

1. In Cursor, create a **Cloud Agent / Automation** with a **webhook** trigger.
2. Paste the contents of [`DRAFTER.md`](./DRAFTER.md) into the automation instructions.
3. Choose the cloud-agent model from your plan.
4. Save the automation, then copy the **webhook URL** and the **API key** Cursor shows (inbound auth for callers).
5. You do **not** set `DRAFT_CALLBACK_SECRET` in Cursor — Automations have no secrets UI for that. The watcher sends `callbackSecret` inside each Prepare payload; the agent uses it as `Authorization: Bearer …` when POSTing `/draft/callback`.

## 2. Render env

On the watcher service (`pesu-placement-watcher`):

| Variable | Value |
|---|---|
| `CURSOR_WEBHOOK_URL` | Webhook URL from step 1 |
| `CURSOR_WEBHOOK_SECRET` | Cursor’s webhook **API key** (Bearer for inbound POST). Same as what you put in local `.env` if you copied it. |
| `DRAFT_CALLBACK_SECRET` | Shared secret (≥32) you invent once — Render only; also mirrored into each Prepare payload as `callbackSecret` |
| `PUBLIC_BASE_URL` | `https://pesu-placement-watcher.onrender.com` |

Redeploy after setting env. Local `.env` does not affect the live Telegram bot.

## 3. Smoke

1. Ensure `/profile` has stored canonical LaTeX.
2. Tap **Prepare** on a drive alert.
3. Expect Telegram “preparing.” then later “Draft ready for …”.
4. Check Supabase `draft` row `status = ready` with latex + answers.

If the webhook or callback fails, fix delivery before building M10 Telegram file send.
