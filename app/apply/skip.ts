import type { Config } from "../config.ts";
import { hasNotion, requireNotion } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { getDrive, tryMarkNotApplied } from "../db/drive.ts";
import { NotionClient } from "../notion/client.ts";
import { syncDrive } from "../notion/sync.ts";
import type { TelegramClient } from "../telegram/client.ts";
import { companyLabel, type VerifyLogger } from "./verify.ts";

export type SkipResult =
  | { kind: "skipped"; company: string }
  | { kind: "not_new"; company: string; status: string | null }
  | { kind: "missing_drive" };

export type SkipDeps = {
  config: Config;
  db: DbClient;
  notion?: NotionClient;
  telegram?: TelegramClient;
  chatId?: string;
  fetch?: typeof globalThis.fetch;
  log?: VerifyLogger;
  now?: Date;
};

/**
 * Manually skip a New drive → Not Applied + Notion sync.
 */
export async function skipDrive(deps: SkipDeps, driveId: string): Promise<SkipResult> {
  const now = deps.now ?? new Date();
  const row = await getDrive(deps.db, driveId);
  if (!row) {
    return { kind: "missing_drive" };
  }
  const company = companyLabel(row.company_name);
  if (row.status !== "New") {
    return { kind: "not_new", company, status: row.status };
  }

  const moved = await tryMarkNotApplied(deps.db, driveId, now);
  if (!moved) {
    const latest = await getDrive(deps.db, driveId);
    return { kind: "not_new", company, status: latest?.status ?? null };
  }

  await syncNotionAfterSkip(deps, driveId, now);
  deps.log?.info({ driveId, outcome: "skipped" }, "drive marked Not Applied via Skip");
  return { kind: "skipped", company };
}

async function syncNotionAfterSkip(deps: SkipDeps, driveId: string, now: Date): Promise<void> {
  if (!hasNotion(deps.config) && !deps.notion) {
    return;
  }
  const row = await getDrive(deps.db, driveId);
  if (!row) {
    return;
  }
  try {
    const notionCfg = hasNotion(deps.config) ? requireNotion(deps.config) : null;
    const notion =
      deps.notion ??
      (notionCfg
        ? new NotionClient({
            token: notionCfg.token,
            fetch: deps.fetch,
            log: deps.log,
          })
        : null);
    if (!notion || !notionCfg) {
      return;
    }
    await syncDrive(
      {
        db: deps.db,
        notion,
        databaseId: notionCfg.databaseId,
        now,
        log: deps.log,
        telegram: deps.telegram,
        chatId: deps.chatId,
      },
      row,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "notion sync error";
    deps.log?.warn({ driveId, reason: message }, "notion sync after Skip failed");
  }
}

export function skipReplyText(result: SkipResult): string {
  switch (result.kind) {
    case "skipped":
      return `Skipped: ${result.company}.`;
    case "missing_drive":
      return "That drive is not in the tracker.";
    case "not_new":
      return `That drive is already ${result.status ?? "not New"}.`;
  }
}
