import type { DbClient } from "../db/client.ts";
import { addReminderTiersSent, listDrives, type DriveRow } from "../db/drive.ts";
import { driveActionKeyboard } from "../telegram/buttons.ts";
import type { TelegramClient } from "../telegram/client.ts";
import { formatDriveAlert } from "../telegram/format.ts";
import {
  nextReminderTierToSend,
  tierLabel,
  type ReminderTierId,
} from "./reminderTiers.ts";

export type ReminderSummary = {
  reminded: number;
  alerts: string[];
};

/**
 * Multi-tier deadline reminders for New drives (12h / 6h / 3h / 1h / 30m).
 * Prepare / draft status does not suppress. Applied / Skip / Not Applied stop via status !== New.
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
    if (row.status !== "New" || !row.deadline) {
      continue;
    }
    const due = nextReminderTierToSend(row.deadline, row.reminder_tiers_sent, now);
    if (due.length === 0) {
      continue;
    }
    // Fire the tightest due tier only (largest index = smallest window).
    const tierId = due[due.length - 1] as ReminderTierId;
    const text = formatDriveAlert(row, {
      urgent: true,
      urgentLabel: tierLabel(tierId),
    });
    const sent = await deps.telegram.sendMessage(deps.chatId, text, driveActionKeyboard(row.id));
    if (!sent.ok) {
      alerts.push(`reminder_send:${row.id}`);
      continue;
    }
    // Mark all due tiers as sent so we don't backlog-spam after downtime.
    await addReminderTiersSent(deps.db, row.id, due, now);
    reminded += 1;
  }

  return { reminded, alerts };
}
