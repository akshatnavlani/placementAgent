/**
 * Register the Render webhook URL with Telegram.
 *
 *   npm run telegram:set-webhook
 */
import { loadConfig, requireTelegram } from "../app/config.ts";

const WEBHOOK_URL = "https://pesu-placement-watcher.onrender.com/telegram/webhook";

const config = loadConfig();
const { botToken, webhookSecret } = requireTelegram(config);

const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: WEBHOOK_URL,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  }),
});

const body = (await res.json()) as { ok?: boolean; description?: string; result?: boolean };
console.log(
  JSON.stringify({
    httpStatus: res.status,
    ok: body.ok === true,
    description: body.description,
    result: body.result,
    url: WEBHOOK_URL,
  }),
);
if (!body.ok) {
  process.exit(1);
}
