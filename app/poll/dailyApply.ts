import { verifyApplied, type VerifyDeps } from "../apply/verify.ts";
import type { DbClient } from "../db/client.ts";
import { listNewDrives, type DriveRow } from "../db/drive.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export type DailyApplySummary = {
  applyChecked: number;
  markedApplied: number;
  alerts: string[];
};

function needsDailyCheck(row: DriveRow, now: Date): boolean {
  if (row.status !== "New") {
    return false;
  }
  if (!row.last_apply_check_at) {
    return true;
  }
  const ms = Date.parse(row.last_apply_check_at);
  if (!Number.isFinite(ms)) {
    return true;
  }
  return now.getTime() - ms >= DAY_MS;
}

/**
 * Once per day per New drive: checkApplyStatus via verifyApplied.
 * Stops early on rateLimited / unavailable.
 */
export async function runDailyApplyPass(
  deps: VerifyDeps & {
    listNew?: () => Promise<DriveRow[]>;
  },
): Promise<DailyApplySummary> {
  const now = deps.now ?? new Date();
  const alerts: string[] = [];
  let applyChecked = 0;
  let markedApplied = 0;
  const news = deps.listNew ? await deps.listNew() : await listNewDrives(deps.db);

  for (const row of news) {
    if (!needsDailyCheck(row, now)) {
      continue;
    }
    const result = await verifyApplied({ ...deps, now }, row.id);
    applyChecked += 1;
    if (result.kind === "applied") {
      markedApplied += 1;
      continue;
    }
    if (result.kind === "could_not_verify") {
      alerts.push(`apply_check:${row.id}:${result.reason}`);
      if (result.reason === "rateLimited" || result.reason === "unavailable") {
        deps.log?.warn({ driveId: row.id, reason: result.reason }, "daily apply pass stopped");
        break;
      }
    }
  }

  return { applyChecked, markedApplied, alerts };
}

/** Exported for tests. */
export const dailyApplyInternals = { needsDailyCheck, DAY_MS };
