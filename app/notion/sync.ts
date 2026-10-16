import type { DbClient } from "../db/client.ts";
import { getDrive, listDrives, setNotionPageId, type DriveRow } from "../db/drive.ts";
import type { TelegramClient } from "../telegram/client.ts";
import { NotionClient, type NotionLogger } from "./client.ts";
import {
  LATER_STAGES,
  mapDriveProperties,
  readNotionStatus,
  WATCHER_STATUSES,
  type NotionStatusName,
} from "./map.ts";

export type NotionSyncLogger = NotionLogger & {
  error?: (obj: Record<string, unknown>, msg?: string) => void;
};

export type SyncDriveResult =
  | { ok: true; action: "created" | "updated" | "recreated" | "skipped" }
  | { ok: false; reason: string; authError?: boolean };

/** Process-lifetime gate so a bad token does not spam Telegram every cron tick. */
let notionAuthAlertSent = false;

/** Test seam. */
export function resetNotionAuthAlertFlag(): void {
  notionAuthAlertSent = false;
}

export type SyncDriveDeps = {
  db: DbClient;
  notion: NotionClient;
  databaseId: string;
  now?: Date;
  log?: NotionSyncLogger;
  telegram?: TelegramClient;
  chatId?: string;
};

async function maybeOpsAlert(deps: SyncDriveDeps, authError: boolean): Promise<void> {
  if (!authError || notionAuthAlertSent) {
    return;
  }
  notionAuthAlertSent = true;
  if (!deps.telegram || !deps.chatId) {
    return;
  }
  await deps.telegram.sendMessage(
    deps.chatId,
    "Notion sync failed: unauthorized — check NOTION_TOKEN / database share",
  );
}

function clearAuthFlagOnSuccess(): void {
  notionAuthAlertSent = false;
}

/**
 * Create or update one drive card. Status guard: never push New over a later Notion stage.
 */
export async function syncDrive(deps: SyncDriveDeps, row: DriveRow): Promise<SyncDriveResult> {
  const now = deps.now ?? new Date();
  const pageId = row.notion_page_id;

  if (!pageId) {
    const createStatus =
      row.status === "Not Applied" || row.status === "Applied"
        ? row.status
        : row.status && LATER_STAGES.has(row.status)
          ? row.status
          : "New";
    const properties = mapDriveProperties(row, {
      includeStatus: true,
      statusOverride: createStatus,
    });
    const created = await deps.notion.createPage(deps.databaseId, properties);
    if (!created.ok) {
      await maybeOpsAlert(deps, Boolean(created.authError));
      return { ok: false, reason: created.reason, authError: created.authError };
    }
    const newId = created.data.id;
    await setNotionPageId(deps.db, row.id, newId, now);
    clearAuthFlagOnSuccess();
    return { ok: true, action: "created" };
  }

  let includeStatus = true;
  let statusOverride: NotionStatusName | undefined;

  if (row.status === "Not Applied" || row.status === "Applied") {
    statusOverride = row.status;
  } else if (row.status && LATER_STAGES.has(row.status)) {
    // Mail worker (and later) may push Assessment / Interview / Accepted / Rejected.
    statusOverride = row.status;
  } else if (row.status === "New" || row.status === null) {
    const retrieved = await deps.notion.retrievePage(pageId);
    if (!retrieved.ok) {
      if (retrieved.code === "object_not_found" || retrieved.status === 404) {
        return recreatePage(deps, row, now);
      }
      await maybeOpsAlert(deps, Boolean(retrieved.authError));
      return { ok: false, reason: retrieved.reason, authError: retrieved.authError };
    }
    const notionStatus = readNotionStatus(retrieved.data.properties);
    if (notionStatus && LATER_STAGES.has(notionStatus)) {
      // Watcher must never revert Assessment+ → New.
      includeStatus = false;
    } else {
      statusOverride = "New";
    }
  } else if (row.status && !WATCHER_STATUSES.has(row.status)) {
    includeStatus = false;
  }

  const properties = mapDriveProperties(row, { includeStatus, statusOverride });
  const updated = await deps.notion.updatePage(pageId, properties);
  if (!updated.ok) {
    if (updated.code === "object_not_found" || updated.status === 404) {
      return recreatePage(deps, row, now);
    }
    await maybeOpsAlert(deps, Boolean(updated.authError));
    return { ok: false, reason: updated.reason, authError: updated.authError };
  }
  clearAuthFlagOnSuccess();
  return { ok: true, action: "updated" };
}

async function recreatePage(
  deps: SyncDriveDeps,
  row: DriveRow,
  now: Date,
): Promise<SyncDriveResult> {
  deps.log?.warn({ driveId: row.id, alert: `notion_recreate:${row.id}` }, "notion page missing; recreating");
  const recreateStatus =
    row.status === "Not Applied" || row.status === "Applied"
      ? row.status
      : row.status && LATER_STAGES.has(row.status)
        ? row.status
        : "New";
  const properties = mapDriveProperties(row, {
    includeStatus: true,
    statusOverride: recreateStatus,
  });
  const created = await deps.notion.createPage(deps.databaseId, properties);
  if (!created.ok) {
    await maybeOpsAlert(deps, Boolean(created.authError));
    return { ok: false, reason: created.reason, authError: created.authError };
  }
  await setNotionPageId(deps.db, row.id, created.data.id, now);
  clearAuthFlagOnSuccess();
  return { ok: true, action: "recreated" };
}

export type SyncEligibleDeps = SyncDriveDeps & {
  /** Drive ids that were insert/refresh this poll. */
  candidateIds: string[];
  /** Drive ids just marked Not Applied. */
  notAppliedIds: string[];
};

export type SyncEligibleSummary = {
  synced: number;
  alerts: string[];
};

/**
 * Sync notify candidates, Not Applied cards with a page id, and any New eligible
 * rows still missing notion_page_id (pre-M4 backfill / retry).
 */
export async function syncEligibleDrives(deps: SyncEligibleDeps): Promise<SyncEligibleSummary> {
  const alerts: string[] = [];
  let synced = 0;
  const seen = new Set<string>();

  const queue: string[] = [...deps.candidateIds];

  for (const id of deps.notAppliedIds) {
    const row = await getDrive(deps.db, id);
    if (row?.notion_page_id) {
      queue.push(id);
    }
  }

  const all = await listDrives(deps.db);
  for (const row of all) {
    if (row.is_eligible === true && row.status === "New" && !row.notion_page_id) {
      queue.push(row.id);
    }
  }

  for (const id of queue) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const row = await getDrive(deps.db, id);
    if (!row) {
      continue;
    }
    // Skip ineligible without a card; Not Applied with a card still syncs status.
    if (row.is_eligible !== true && row.status !== "Not Applied") {
      continue;
    }
    if (row.status !== "New" && row.status !== "Not Applied" && row.status !== "Applied" && !row.notion_page_id) {
      continue;
    }

    const result = await syncDrive(deps, row);
    if (result.ok) {
      if (result.action !== "skipped") {
        synced += 1;
      }
    } else {
      if (result.authError) {
        alerts.push("notion_auth");
        deps.log?.warn({ driveId: id, reason: result.reason }, "notion auth failed");
        break;
      }
      alerts.push(`notion_write:${id}`);
      deps.log?.warn({ driveId: id, reason: result.reason }, "notion write failed");
    }
  }

  return { synced, alerts };
}
