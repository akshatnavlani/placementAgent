import {
  syncCalendarEvent,
  type SyncEventResult,
} from "../calendar/syncEvent.ts";
import type { Config } from "../config.ts";
import { hasNotion, requireNotion } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import {
  getDrive,
  markRejectionAsked,
  setMailStage,
  type DriveRow,
  type MailStageStatus,
} from "../db/drive.ts";
import {
  bindMailDrive,
  markMailNotified,
  type MailClassification,
  type MailRow,
} from "../db/mail.ts";
import { NotionClient } from "../notion/client.ts";
import { syncDrive } from "../notion/sync.ts";
import type { TelegramClient } from "../telegram/client.ts";
import { chooseMailDriveKeyboard, confirmRejectKeyboard } from "../telegram/buttons.ts";
import { isStrongOfferReason, type MailClassificationResult } from "./classify.ts";
import { isActionableMailClassification } from "./placementGate.ts";
import { driveChoiceLabel, formatAmbiguousMail, formatStageChange } from "./notify.ts";

export type ApplyClassificationDeps = {
  config: Config;
  db: DbClient;
  telegram?: TelegramClient;
  chatId?: string;
  notion?: NotionClient;
  fetch?: typeof globalThis.fetch;
  now?: Date;
  /** Mail body text for calendar time parsing (not stored on mail row). */
  bodyText?: string;
  log?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
};

export type ApplyResult = {
  statusWritten: MailStageStatus | null;
  notified: boolean;
  asked: boolean;
  skipped: boolean;
  reason: string;
};

function targetStatus(
  classification: MailClassification,
  result: MailClassificationResult,
): MailStageStatus | "leave" | "none" {
  switch (classification) {
    case "shortlist_present":
      if (result.reason.includes("assessment") || /\bassessment\b/i.test(result.reason)) {
        return "Assessment";
      }
      // Leave Applied; notify shortlisted. Assessment only when clearly assessment.
      return "leave";
    case "shortlist_absent":
      if (result.listComplete === true && result.confidence === "high") {
        return "Rejected";
      }
      return "none";
    case "assessment":
      return "Assessment";
    case "interview":
      return "Interview";
    case "rejection":
      return "Rejected";
    case "offer_received":
      return isStrongOfferReason(result.reason) ? "Accepted" : "none";
    case "offer_accepted":
    case "offer_confirmed":
      return "Accepted";
    case "reschedule":
    case "cancel":
    case "unresolved":
      return "none";
    default:
      return "none";
  }
}

async function syncNotionAfterStage(
  deps: ApplyClassificationDeps,
  driveId: string,
  now: Date,
): Promise<void> {
  const row = await getDrive(deps.db, driveId);
  if (!row) {
    return;
  }
  try {
    const notionCfg = hasNotion(deps.config) ? requireNotion(deps.config) : null;
    const notionLog =
      deps.log?.info && deps.log?.warn
        ? { info: deps.log.info, warn: deps.log.warn }
        : undefined;
    const notion =
      deps.notion ??
      (notionCfg
        ? new NotionClient({
            token: notionCfg.token,
            fetch: deps.fetch,
            log: notionLog,
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
        log: notionLog,
        telegram: deps.telegram,
        chatId: deps.chatId,
      },
      row,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "notion sync error";
    deps.log?.warn?.({ driveId, reason: message }, "notion sync after mail stage failed");
  }
}

async function notifyOnce(
  deps: ApplyClassificationDeps,
  mail: MailRow,
  text: string,
  replyMarkup?: Record<string, unknown>,
  now: Date = new Date(),
): Promise<boolean> {
  if (mail.notified_at) {
    return false;
  }
  if (!deps.telegram || !deps.chatId) {
    return false;
  }
  const sent = await deps.telegram.sendMessage(deps.chatId, text, replyMarkup);
  if (!sent.ok) {
    deps.log?.warn?.(
      { mailId: mail.id, reason: "telegram_send_failed" },
      "mail notify failed",
    );
    return false;
  }
  await markMailNotified(deps.db, mail.id, now);
  return true;
}

/**
 * Apply a classified mail row: optional status write, Notion sync, Telegram once.
 * When driveId is missing and candidates provided, ask via keyboard.
 */
export async function applyClassification(
  deps: ApplyClassificationDeps,
  mail: MailRow,
  classifyResult: MailClassificationResult,
  options: {
    drive?: DriveRow | null;
    ambiguousCandidates?: DriveRow[];
    bodyText?: string;
  } = {},
): Promise<ApplyResult> {
  const now = deps.now ?? new Date();
  const classification = mail.classification;
  const bodyText = options.bodyText ?? deps.bodyText ?? "";

  // Never Telegram spam unresolved / low-confidence mail.
  if (!isActionableMailClassification(classifyResult)) {
    return {
      statusWritten: null,
      notified: false,
      asked: false,
      skipped: true,
      reason: classifyResult.reason || "not_actionable",
    };
  }

  // Ambiguity ask — only for high-signal classifications
  if (!mail.drive_id && options.ambiguousCandidates && options.ambiguousCandidates.length > 0) {
    if (mail.notified_at) {
      return { statusWritten: null, notified: false, asked: false, skipped: true, reason: "already_asked" };
    }
    const text = formatAmbiguousMail(mail.subject, classification, classifyResult.reason);
    const keyboard = chooseMailDriveKeyboard(
      mail.id,
      options.ambiguousCandidates.map((d) => ({
        id: d.id,
        label: driveChoiceLabel(d.company_name, d.event_name),
      })),
    );
    const notified = await notifyOnce(deps, mail, text, keyboard, now);
    return {
      statusWritten: null,
      notified,
      asked: true,
      skipped: false,
      reason: "ask_drive",
    };
  }

  // No drive match: still Telegram high-signal stage mail (Zensar postponed, etc.).
  if (!mail.drive_id && !options.drive) {
    const notifyUnmatched =
      classification === "reschedule" ||
      classification === "cancel" ||
      classification === "interview" ||
      classification === "assessment" ||
      classification === "rejection" ||
      classification === "offer_received" ||
      classification === "offer_accepted" ||
      classification === "offer_confirmed" ||
      classification === "shortlist_present";
    if (notifyUnmatched) {
      const text = formatStageChange(
        null,
        classification,
        classifyResult.reason,
        null,
        mail.subject,
      );
      const notified = await notifyOnce(deps, mail, text, undefined, now);
      return {
        statusWritten: null,
        notified,
        asked: false,
        skipped: !notified,
        reason: notified ? "no_drive_match_notified" : "no_drive_match",
      };
    }
    return {
      statusWritten: null,
      notified: false,
      asked: false,
      skipped: true,
      reason: "no_drive_match",
    };
  }

  const drive = options.drive ?? (mail.drive_id ? await getDrive(deps.db, mail.drive_id) : null);
  if (mail.drive_id && !drive) {
    return {
      statusWritten: null,
      notified: false,
      asked: false,
      skipped: true,
      reason: "missing_drive",
    };
  }

  // Incomplete shortlist absent: ask user whether to mark Rejected (no auto status write).
  if (
    classification === "shortlist_absent" &&
    classifyResult.listComplete !== true
  ) {
    if (!drive) {
      const text = formatStageChange(
        null,
        classification,
        "shortlist looks incomplete — left status unchanged",
        null,
        mail.subject,
      );
      const notified = await notifyOnce(deps, mail, text, undefined, now);
      return {
        statusWritten: null,
        notified,
        asked: false,
        skipped: !notified,
        reason: "shortlist_incomplete",
      };
    }
    const label = driveChoiceLabel(drive.company_name, drive.event_name);
    const text = `Shortlist for ${label} looks incomplete and you are not listed. Mark Rejected?`;
    const notified = await notifyOnce(
      deps,
      mail,
      text,
      confirmRejectKeyboard(drive.id),
      now,
    );
    if (notified) {
      await markRejectionAsked(deps.db, drive.id, now);
    }
    return {
      statusWritten: null,
      notified,
      asked: notified,
      skipped: false,
      reason: "shortlist_incomplete_ask",
    };
  }

  const target = targetStatus(classification, classifyResult);
  let statusWritten: MailStageStatus | null = null;

  if (target !== "none" && target !== "leave" && drive) {
    const result = await setMailStage(deps.db, drive.id, target, now);
    if (result.ok) {
      statusWritten = target;
      await syncNotionAfterStage(deps, drive.id, now);
    } else {
      deps.log?.info?.(
        { driveId: drive.id, target, reason: result.reason },
        "mail stage write skipped",
      );
    }
  } else if (target === "leave" && drive) {
    // shortlist_present without assessment implication — no status change
    statusWritten = null;
  }

  let calendar: SyncEventResult | null = null;
  if (
    drive &&
    (classification === "assessment" ||
      classification === "interview" ||
      classification === "reschedule" ||
      classification === "cancel")
  ) {
    try {
      calendar = await syncCalendarEvent({
        config: deps.config,
        db: deps.db,
        drive,
        classification,
        subject: mail.subject,
        body: bodyText,
        fetch: deps.fetch,
        now,
        log: deps.log,
      });
      if (!calendar.ok) {
        deps.log?.warn?.(
          { driveId: drive.id, reason: calendar.reason },
          "calendar sync failed",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "calendar error";
      deps.log?.warn?.({ driveId: drive.id, reason: message }, "calendar sync threw");
      calendar = { ok: false, action: "skip", reason: message };
    }
  }

  // Informational reschedule/cancel / stage notify
  const text = formatStageChange(
    drive,
    classification,
    classifyResult.reason,
    calendar,
    mail.subject,
  );
  const notified = await notifyOnce(deps, mail, text, undefined, now);

  return {
    statusWritten,
    notified,
    asked: false,
    skipped: false,
    reason: classifyResult.reason,
  };
}

/** After user picks a drive from mail: keyboard, bind and re-apply. */
export async function bindMailAndApply(
  deps: ApplyClassificationDeps,
  mail: MailRow,
  driveId: string,
  classifyResult: MailClassificationResult,
): Promise<ApplyResult> {
  const now = deps.now ?? new Date();
  await bindMailDrive(deps.db, mail.id, driveId, now, { clearNotified: true });
  const drive = await getDrive(deps.db, driveId);
  const bound: MailRow = { ...mail, drive_id: driveId, notified_at: null };
  return applyClassification(deps, bound, classifyResult, { drive });
}
