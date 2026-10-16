import type { DbClient } from "../db/client.ts";
import { listDrives, markAlerted, type DriveRow } from "../db/drive.ts";
import { driveActionKeyboard } from "../telegram/buttons.ts";
import type { TelegramClient } from "../telegram/client.ts";
import { formatDriveAlert, isUrgentDeadline, SIX_HOURS_MS } from "../telegram/format.ts";

export type ReminderSummary = {
  reminded: number;
  alerts: string[];
};

function stillOpenBeforeDeadline(row: DriveRow, now: Date): boolean {
  if (row.status !== "New" || row.reminder_sent || !row.deadline) {
    return false;
  }
  const ms = Date.parse(row.deadline);
  if (!Number.isFinite(ms)) {
    return false;
  }
  const remaining = ms - now.getTime();
  return remaining > 0 && remaining < SIX_HOURS_MS;
}

/**
 * One urgent reminder for New drives that entered the under-6h window after first alert.
 */
export async function sendDeadlineReminders(deps: {
  db: DbClient;
  telegram: TelegramClient;
  chatId: string;
  now?: Date;
  listExisting?: () => Promise<DriveRow[]>;
}): Promise<ReminderSummary> {
  const now = deps.now ?? new Date();
  const alerts: string[] = [];
  let reminded = 0;
  const rows = deps.listExisting ? await deps.listExisting() : await listDrives(deps.db);

  for (const row of rows) {
    if (!stillOpenBeforeDeadline(row, now)) {
      continue;
    }
    // isUrgentDeadline is the same window; keep shared helper as source of truth.
    if (!isUrgentDeadline(row.deadline, now)) {
      continue;
    }
    const text = formatDriveAlert(row, { urgent: true });
    const sent = await deps.telegram.sendMessage(deps.chatId, text, driveActionKeyboard(row.id));
    if (!sent.ok) {
      alerts.push(`reminder_send:${row.id}`);
      continue;
    }
    await markAlerted(deps.db, row.id, { reminderSent: true }, now);
    reminded += 1;
  }

  return { reminded, alerts };
}
