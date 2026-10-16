import type { DbClient } from "../db/client.ts";
import { markAlerted, type DriveRow } from "../db/drive.ts";
import { driveActionKeyboard } from "./buttons.ts";
import type { TelegramClient } from "./client.ts";
import { formatDriveAlert, isUrgentDeadline } from "./format.ts";

export type NotifyResult =
  | { ok: true; urgent: boolean }
  | { ok: false; reason: string };

export async function notifyEligibleDrive(
  deps: {
    db: DbClient;
    telegram: TelegramClient;
    chatId: string;
    now?: Date;
  },
  row: DriveRow,
): Promise<NotifyResult> {
  const now = deps.now ?? new Date();
  const urgent = isUrgentDeadline(row.deadline, now);
  const text = formatDriveAlert(row, { urgent });
  const sent = await deps.telegram.sendMessage(deps.chatId, text, driveActionKeyboard(row.id));
  if (!sent.ok) {
    return { ok: false, reason: sent.reason };
  }
  await markAlerted(deps.db, row.id, { reminderSent: urgent }, now);
  return { ok: true, urgent };
}
