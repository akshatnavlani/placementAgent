import type { Config } from "../config.ts";
import { hasNotion, requireNotion, requirePlacementCredentials } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import {
  getDrive,
  listActiveAppliedDrives,
  markRejectionAsked,
  setMailStage,
  type DriveRow,
} from "../db/drive.ts";
import { loadBearerToken } from "../db/secret.ts";
import { NotionClient } from "../notion/client.ts";
import { syncDrive } from "../notion/sync.ts";
import type { PlacementClient } from "../placement/client.ts";
import { companyLabel } from "./verify.ts";
import { confirmRejectKeyboard } from "../telegram/buttons.ts";
import type { TelegramClient } from "../telegram/client.ts";

const ASK_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type ReconcileDeps = {
  config: Config;
  db: DbClient;
  placement: PlacementClient;
  telegram?: TelegramClient;
  chatId?: string;
  notion?: NotionClient;
  fetch?: typeof globalThis.fetch;
  now?: Date;
  log?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
  listActive?: () => Promise<DriveRow[]>;
};

export type ReconcileSummary = {
  checked: number;
  asked: number;
  alerts: string[];
};

export function needsRejectionAsk(row: DriveRow, now: Date, cooldownMs = ASK_COOLDOWN_MS): boolean {
  if (!row.last_rejection_ask_at) {
    return true;
  }
  const ms = Date.parse(row.last_rejection_ask_at);
  if (!Number.isFinite(ms)) {
    return true;
  }
  return now.getTime() - ms >= cooldownMs;
}

/**
 * Compare local Applied+ drives to getAppliedEvents; ask Telegram when missing.
 */
export async function reconcileAppliedEvents(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const now = deps.now ?? new Date();
  const alerts: string[] = [];
  let checked = 0;
  let asked = 0;

  const secret = await loadBearerToken(deps.db);
  if (!secret.bearerToken) {
    return { checked: 0, asked: 0, alerts: ["no_token"] };
  }

  let studentId: string;
  try {
    studentId = requirePlacementCredentials(deps.config).studentId;
  } catch {
    return { checked: 0, asked: 0, alerts: ["placement_credentials_missing"] };
  }

  const listed = await deps.placement.getAppliedEvents(secret.bearerToken, studentId);
  if (listed.kind !== "ok") {
    const reason = listed.kind === "network" ? listed.message : listed.kind;
    return { checked: 0, asked: 0, alerts: [`getAppliedEvents:${reason}`] };
  }

  const onPlatform = new Set(listed.data.map((item) => item.eventId));
  const active = deps.listActive ? await deps.listActive() : await listActiveAppliedDrives(deps.db);
  checked = active.length;

  if (!deps.telegram || !deps.chatId) {
    return { checked, asked: 0, alerts: [...alerts, "telegram_skipped"] };
  }

  for (const row of active) {
    if (onPlatform.has(row.id)) {
      continue;
    }
    if (!needsRejectionAsk(row, now)) {
      continue;
    }
    const company = companyLabel(row.company_name);
    const text = `${company} is no longer on the platform Applied list. Were you rejected?`;
    const sent = await deps.telegram.sendMessage(
      deps.chatId,
      text,
      confirmRejectKeyboard(row.id),
    );
    await markRejectionAsked(deps.db, row.id, now);
    if (sent.ok) {
      asked += 1;
    } else {
      alerts.push(`reject_ask:${row.id}`);
      deps.log?.warn?.({ driveId: row.id, reason: sent.reason }, "rejection ask failed");
    }
  }

  return { checked, asked, alerts };
}

export async function confirmDriveRejected(
  deps: Omit<ReconcileDeps, "placement">,
  driveId: string,
): Promise<{ ok: true; company: string } | { ok: false; reason: string }> {
  const now = deps.now ?? new Date();
  const row = await getDrive(deps.db, driveId);
  if (!row) {
    return { ok: false, reason: "missing_drive" };
  }
  const company = companyLabel(row.company_name);
  const stage = await setMailStage(deps.db, driveId, "Rejected", now);
  if (!stage.ok) {
    return { ok: false, reason: stage.reason };
  }
  await syncNotionAfterReject(deps, driveId, now);
  return { ok: true, company };
}

export async function confirmDriveStillApplied(
  deps: Pick<ReconcileDeps, "db" | "now">,
  driveId: string,
): Promise<{ ok: true; company: string } | { ok: false; reason: string }> {
  const now = deps.now ?? new Date();
  const row = await getDrive(deps.db, driveId);
  if (!row) {
    return { ok: false, reason: "missing_drive" };
  }
  await markRejectionAsked(deps.db, driveId, now);
  return { ok: true, company: companyLabel(row.company_name) };
}

async function syncNotionAfterReject(
  deps: Omit<ReconcileDeps, "placement">,
  driveId: string,
  now: Date,
): Promise<void> {
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
            log: deps.log?.info && deps.log?.warn
              ? { info: deps.log.info, warn: deps.log.warn }
              : undefined,
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
        log:
          deps.log?.info && deps.log?.warn
            ? { info: deps.log.info, warn: deps.log.warn }
            : undefined,
        telegram: deps.telegram,
        chatId: deps.chatId,
      },
      row,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "notion sync error";
    deps.log?.warn?.({ driveId, reason: message }, "notion sync after reject failed");
  }
}

export const reconcileInternals = { ASK_COOLDOWN_MS, needsRejectionAsk };
