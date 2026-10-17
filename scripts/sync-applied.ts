/**
 * One-shot: import getAppliedEvents into Supabase + Notion (quiet mail).
 * Usage: npm run build && node --env-file-if-exists=.env scripts/sync-applied.ts
 * Or after deploy: Telegram /syncapplied
 */
import { importAppliedEvents, importAppliedReplyText } from "../app/apply/importApplied.ts";
import { loadConfig } from "../app/config.ts";
import { createDbClient } from "../app/db/client.ts";
import { clearBearerToken } from "../app/db/secret.ts";
import { PlacementClient } from "../app/placement/client.ts";

const config = loadConfig(process.env);
if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
  process.exit(1);
}

const db = createDbClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
const placement = new PlacementClient({
  log: {
    info: (obj, msg) => console.log(msg ?? "info", obj),
    warn: (obj, msg) => console.warn(msg ?? "warn", obj),
  },
  onUnauthorized: async () => {
    await clearBearerToken(db);
  },
});

const summary = await importAppliedEvents({
  config,
  db,
  placement,
  log: {
    info: (obj, msg) => console.log(msg ?? "info", obj),
    warn: (obj, msg) => console.warn(msg ?? "warn", obj),
  },
});

console.log(importAppliedReplyText(summary));
process.exit(summary.ok || summary.fetched > 0 ? 0 : 1);
