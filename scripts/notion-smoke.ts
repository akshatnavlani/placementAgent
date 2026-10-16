/**
 * Live Notion sync smoke: load config, sync eligible drives missing page ids.
 * Does not print secrets or full page payloads.
 */
import { loadConfig, requireNotion, requireSupabase, hasTelegram, requireTelegram } from "../app/config.ts";
import { createDbClient } from "../app/db/client.ts";
import { listDrives } from "../app/db/drive.ts";
import { NotionClient } from "../app/notion/client.ts";
import { syncEligibleDrives } from "../app/notion/sync.ts";
import { TelegramClient } from "../app/telegram/client.ts";

const config = loadConfig();
const supabase = requireSupabase(config);
const notionCfg = requireNotion(config);
const db = createDbClient(supabase.url, supabase.serviceRoleKey);
const notion = new NotionClient({ token: notionCfg.token });

let telegram: TelegramClient | undefined;
let chatId: string | undefined;
if (hasTelegram(config)) {
  const tg = requireTelegram(config);
  telegram = new TelegramClient({ botToken: tg.botToken });
  chatId = tg.chatId;
}

const before = await listDrives(db);
const missing = before.filter((d) => d.is_eligible === true && d.status === "New" && !d.notion_page_id);
console.log(
  JSON.stringify({
    drives: before.length,
    missingPageId: missing.length,
    withPageId: before.filter((d) => d.notion_page_id).length,
  }),
);

const result = await syncEligibleDrives({
  db,
  notion,
  databaseId: notionCfg.databaseId,
  candidateIds: [],
  notAppliedIds: [],
  telegram,
  chatId,
});

const after = await listDrives(db);
console.log(
  JSON.stringify({
    synced: result.synced,
    alerts: result.alerts,
    withPageId: after.filter((d) => d.notion_page_id).length,
    sampleTitles: after
      .filter((d) => d.notion_page_id)
      .slice(0, 5)
      .map((d) => ({ company: d.company_name, pageIdLen: d.notion_page_id?.length ?? 0 })),
  }),
);
