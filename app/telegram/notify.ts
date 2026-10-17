import type { DbClient } from "../db/client.ts";
import { markAlerted, type DriveRow } from "../db/drive.ts";
import { tierLabel, tiersImpliedByRemaining } from "../poll/reminderTiers.ts";
import { driveActionKeyboard } from "./buttons.ts";
import type { TelegramClient } from "./client.ts";
import { formatDriveAlert } from "./format.ts";

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
  let urgent = false;
  let urgentLabel: string | undefined;
  let impliedTiers = [] as ReturnType<typeof tiersImpliedByRemaining>;
  if (row.deadline) {
    const ms = Date.parse(row.deadline);
    if (Number.isFinite(ms)) {
      const remaining = ms - now.getTime();
      impliedTiers = tiersImpliedByRemaining(remaining);
      if (impliedTiers.length > 0) {
        urgent = true;
        urgentLabel = tierLabel(impliedTiers[impliedTiers.length - 1]!);
      }
    }
  }
  const text = formatDriveAlert(row, { urgent, urgentLabel });
  const sent = await deps.telegram.sendMessage(deps.chatId, text, driveActionKeyboard(row.id));
  if (!sent.ok) {
    return { ok: false, reason: sent.reason };
  }
  await markAlerted(
    deps.db,
    row.id,
    {
      reminderSent: urgent,
      reminderTiers: impliedTiers.length > 0 ? impliedTiers : undefined,
    },
    now,
  );
  return { ok: true, urgent };
}
