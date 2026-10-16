# Cursor automation setup (M9)

The watcher does not create the automation. You create it once in Cursor, then point Render at its webhook URL.

## 1. Create the automation

1. In Cursor, create a **Cloud Agent / Automation** with a **webhook** trigger.
2. Paste the contents of [`DRAFTER.md`](./DRAFTER.md) into the automation instructions.
3. Choose the cloud-agent model from your plan.
4. Set automation env:
   - `DRAFT_CALLBACK_SECRET` — same ≥32-char secret as Render
5. Copy the webhook URL Cursor gives you.

## 2. Render env

On the watcher service (`pesu-placement-watcher`):

| Variable | Value |
|---|---|
| `CURSOR_WEBHOOK_URL` | Webhook URL from step 1 |
| `CURSOR_WEBHOOK_SECRET` | Optional Bearer secret if Cursor requires one on inbound webhook |
| `DRAFT_CALLBACK_SECRET` | Shared secret (≥32) for `POST /draft/callback` |
| `PUBLIC_BASE_URL` | `https://pesu-placement-watcher.onrender.com` |

Redeploy after setting env.

## 3. Smoke

1. Ensure `/profile` has stored canonical LaTeX.
2. Tap **Prepare** on a drive alert.
3. Expect Telegram “preparing.” then later “Draft ready for …”.
4. Check Supabase `draft` row `status = ready` with latex + answers.

If the webhook or callback fails, fix delivery before building M10 Telegram file send.
