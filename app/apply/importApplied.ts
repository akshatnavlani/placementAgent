import type { Config } from "../config.ts";
import {
  hasNotion,
  requireNotion,
  requirePlacementCredentials,
} from "../config.ts";
import type { DbClient } from "../db/client.ts";
import {
  getDrive,
  markAppliedFromImport,
  setDetail,
  setMailStage,
  stampAppliedTimestamps,
  upsertFromList,
} from "../db/drive.ts";
import { loadBearerToken } from "../db/secret.ts";
import { syncRecruitmentMail } from "../mail/sync.ts";
import { NotionClient } from "../notion/client.ts";
import { syncDrive } from "../notion/sync.ts";
import {
  appliedSelectionWantsAccepted,
  type AppliedEventItem,
  type PlacementClient,
} from "../placement/client.ts";
import { eventDisplayFields, extractPdfUrls } from "../poll/diff.ts";
import type { TelegramClient } from "../telegram/client.ts";

export type ImportAppliedLogger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
};

export type ImportAppliedDeps = {
  config: Config;
  db: DbClient;
  placement: PlacementClient;
  notion?: NotionClient;
  telegram?: TelegramClient;
  chatId?: string;
  fetch?: typeof globalThis.fetch;
  log?: ImportAppliedLogger;
  now?: Date;
  /** When false, skip mail pass (tests). Default true. */
  syncMail?: boolean;
};

export type ImportAppliedSummary = {
  ok: boolean;
  fetched: number;
  imported: number;
  alreadyTracked: number;
  accepted: number;
  notionSynced: number;
  mailProcessed: number;
  alerts: string[];
};

function emptySummary(partial: Partial<ImportAppliedSummary> = {}): ImportAppliedSummary {
  return {
    ok: false,
    fetched: 0,
    imported: 0,
    alreadyTracked: 0,
    accepted: 0,
    notionSynced: 0,
    mailProcessed: 0,
    alerts: [],
    ...partial,
  };
}

async function syncNotionRow(
  deps: ImportAppliedDeps,
  driveId: string,
  now: Date,
): Promise<boolean> {
  if (!hasNotion(deps.config) && !deps.notion) {
    return false;
  }
  const row = await getDrive(deps.db, driveId);
  if (!row) {
    return false;
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
      return false;
    }
    const result = await syncDrive(
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
    return result.ok;
  } catch (error) {
    const message = error instanceof Error ? error.message : "notion sync error";
    deps.log?.warn({ driveId, reason: message }, "notion sync after import failed");
    return false;
  }
}

async function enrichFromDetail(
  deps: ImportAppliedDeps,
  token: string,
  item: AppliedEventItem,
  now: Date,
): Promise<void> {
  const detail = await deps.placement.getEventDetails(token, item.eventId);
  if (detail.kind !== "ok") {
    deps.log?.warn(
      { driveId: item.eventId, reason: detail.kind },
      "getEventDetails during applied import failed",
    );
    return;
  }
  const display = eventDisplayFields(detail.data);
  await upsertFromList(
    deps.db,
    {
      id: item.eventId,
      rawList: item.raw,
      updatedAtPlatform: display.updatedAtPlatform,
      isEligible: typeof detail.data.isEligible === "boolean" ? detail.data.isEligible : null,
      deadline: display.deadline,
      statusOnInsert: null,
      setStatusNewIfNull: false,
      companyId: display.companyId,
      companyName: display.companyName ?? item.companyName,
      companyUsername: display.companyUsername ?? item.companyUsername,
      eventName: display.eventName ?? item.eventName,
      pdfUrls: extractPdfUrls(detail.data),
    },
    now,
  );
  await setDetail(deps.db, item.eventId, detail.data as Record<string, unknown>, now);
}

/**
 * Pull getAppliedEvents, upsert Applied drives, Notion sync, then quiet mail pass.
 */
export async function importAppliedEvents(deps: ImportAppliedDeps): Promise<ImportAppliedSummary> {
  const now = deps.now ?? new Date();
  const alerts: string[] = [];
  const secret = await loadBearerToken(deps.db);
  if (!secret.bearerToken) {
    return emptySummary({ alerts: ["no_bearer_token"] });
  }

  let studentId: string;
  try {
    studentId = requirePlacementCredentials(deps.config).studentId;
  } catch {
    return emptySummary({ alerts: ["placement_credentials_missing"] });
  }

  const listed = await deps.placement.getAppliedEvents(secret.bearerToken, studentId);
  if (listed.kind !== "ok") {
    const reason = listed.kind === "network" ? listed.message : listed.kind;
    return emptySummary({ alerts: [`getAppliedEvents:${reason}`] });
  }

  const items = listed.data;
  let imported = 0;
  let alreadyTracked = 0;
  let accepted = 0;
  let notionSynced = 0;

  for (const item of items) {
    const existing = await getDrive(deps.db, item.eventId);
    const wantAccepted = appliedSelectionWantsAccepted(item.selectionStatus);

    if (!existing) {
      await upsertFromList(
        deps.db,
        {
          id: item.eventId,
          rawList: item.raw,
          updatedAtPlatform: null,
          isEligible: null,
          deadline: null,
          statusOnInsert: "Applied",
          setStatusNewIfNull: false,
          companyId: null,
          companyName: item.companyName,
          companyUsername: item.companyUsername,
          eventName: item.eventName,
          pdfUrls: [],
        },
        now,
      );
      await stampAppliedTimestamps(deps.db, item.eventId, now);
      await enrichFromDetail(deps, secret.bearerToken, item, now);
      imported += 1;
    } else {
      const moved = await markAppliedFromImport(deps.db, item.eventId, now);
      if (moved) {
        await enrichFromDetail(deps, secret.bearerToken, item, now);
        imported += 1;
      } else {
        alreadyTracked += 1;
      }
    }

    if (wantAccepted) {
      const stage = await setMailStage(deps.db, item.eventId, "Accepted", now);
      if (stage.ok && stage.from !== "Accepted") {
        accepted += 1;
      }
    }

    if (await syncNotionRow(deps, item.eventId, now)) {
      notionSynced += 1;
    }
  }

  let mailProcessed = 0;
  if (deps.syncMail !== false) {
    try {
      const mail = await syncRecruitmentMail({
        config: deps.config,
        db: deps.db,
        log: deps.log,
        fetch: deps.fetch,
        now,
        telegram: deps.telegram,
        notify: false,
      });
      mailProcessed = mail.processed;
      if (!mail.ok) {
        alerts.push(...mail.alerts.slice(0, 5));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "mail sync error";
      alerts.push(`mail:${message}`);
    }
  }

  return {
    ok: alerts.length === 0 || imported + alreadyTracked > 0,
    fetched: items.length,
    imported,
    alreadyTracked,
    accepted,
    notionSynced,
    mailProcessed,
    alerts,
  };
}

export function importAppliedReplyText(summary: ImportAppliedSummary): string {
  if (!summary.ok && summary.fetched === 0 && summary.alerts.length > 0) {
    return `Could not import applications: ${summary.alerts[0]}`;
  }
  const lines = [
    "Applied import done.",
    `Fetched: ${summary.fetched} · Imported: ${summary.imported} · Already tracked: ${summary.alreadyTracked}`,
    `Accepted: ${summary.accepted} · Notion: ${summary.notionSynced} · Mail processed: ${summary.mailProcessed}`,
  ];
  if (summary.alerts.length > 0) {
    lines.push(`Alerts: ${summary.alerts.slice(0, 5).join(", ")}`);
  }
  return lines.join("\n");
}
