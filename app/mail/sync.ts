import type { Config } from "../config.ts";
import { hasTelegram, requireTelegram } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { listDrives } from "../db/drive.ts";
import {
  classificationRank,
  classifyRecruitmentMail,
  nameTokensFromProfile,
  type MailClassificationResult,
} from "./classify.ts";
import {
  getMailByMessageId,
  getMailSyncCursor,
  setMailSyncCursor,
  upsertMail,
  type MailAccount,
  type MailClassification,
} from "../db/mail.ts";
import { loadPlatformProfile } from "../db/profile.ts";
import { listConfiguredMailboxes } from "../gmail/accounts.ts";
import type { GmailClient } from "../gmail/client.ts";
import { NotionClient } from "../notion/client.ts";
import { TelegramClient } from "../telegram/client.ts";
import { applyClassification } from "./applyClassification.ts";
import { matchDrive } from "./matchDrive.ts";

const BOOTSTRAP_QUERY =
  "(shortlist OR interview OR assessment OR offer OR rejected OR rejection OR selection OR shortlisted) newer_than:21d";
const BOOTSTRAP_CAP = 50;

export type MailSyncLogger = {
  info?: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
  error?: (obj: Record<string, unknown>, msg?: string) => void;
};

export type SyncRecruitmentMailDeps = {
  config: Config;
  db: DbClient;
  log?: MailSyncLogger;
  fetch?: typeof globalThis.fetch;
  now?: Date;
  telegram?: TelegramClient;
  notion?: NotionClient;
  /** Test seam: override mailboxes. */
  mailboxes?: Array<{ account: MailAccount; client: GmailClient }>;
  /** When false, skip Telegram even if configured. */
  notify?: boolean;
};

export type MailSyncSummary = {
  ok: boolean;
  accounts: number;
  processed: number;
  notified: number;
  skipped: number;
  alerts: string[];
};

function classifyToStored(result: MailClassificationResult): {
  classification: MailClassification;
  confidence: "high" | "low";
} {
  return {
    classification: result.classification,
    confidence: result.confidence,
  };
}

async function bootstrapMessageIds(
  client: GmailClient,
): Promise<{ ok: true; ids: string[]; historyId: string } | { ok: false; reason: string }> {
  const profile = await client.getProfile();
  if (!profile.ok) {
    return profile;
  }
  const listed = await client.listMessageIds(BOOTSTRAP_QUERY, BOOTSTRAP_CAP);
  if (!listed.ok) {
    return listed;
  }
  return { ok: true, ids: listed.ids, historyId: profile.historyId };
}

async function processMessage(
  deps: SyncRecruitmentMailDeps,
  account: MailAccount,
  client: GmailClient,
  messageId: string,
  studentTokens: string[],
  drives: Awaited<ReturnType<typeof listDrives>>,
  summary: MailSyncSummary,
  now: Date,
): Promise<void> {
  const existing = await getMailByMessageId(deps.db, account, messageId);
  const full = await client.getMessageFull(messageId);
  if (!full.ok) {
    deps.log?.warn?.(
      { account, messageId, reason: full.reason },
      "mail fetch skipped",
    );
    summary.skipped += 1;
    return;
  }
  const msg = full.message;
  const classified = classifyRecruitmentMail({
    subject: msg.subject,
    snippet: msg.snippet,
    bodyText: msg.bodyText,
    studentNameTokens: studentTokens,
  });

  if (
    existing &&
    existing.classification === classified.classification &&
    existing.notified_at
  ) {
    summary.skipped += 1;
    return;
  }

  const upward =
    existing &&
    classificationRank(classified.classification) > classificationRank(existing.classification);

  if (existing && !upward && existing.classification === classified.classification) {
    summary.skipped += 1;
    return;
  }

  const match = matchDrive(drives, msg.subject, msg.bodyText);
  let driveId: string | null = existing?.drive_id ?? null;
  let ambiguous: typeof drives = [];

  if (match.kind === "one") {
    driveId = match.drive.id;
  } else if (match.kind === "many") {
    driveId = null;
    ambiguous = match.candidates.map((c) => c.drive);
  } else if (!driveId) {
    // none
    if (classified.classification !== "unresolved" && classified.confidence === "high") {
      // keep classification but will ask / unresolved path
      ambiguous = [];
    }
  }

  const stored = classifyToStored(classified);

  const mail = await upsertMail(
    deps.db,
    {
      account,
      gmailMessageId: messageId,
      gmailThreadId: msg.threadId || null,
      driveId,
      classification: stored.classification,
      confidence: stored.confidence,
      subject: msg.subject.slice(0, 500),
      snippet: msg.snippet.slice(0, 500),
      rawMeta: {
        account,
        // headers/labels only — no body
        internalDateMs: msg.internalDateMs,
      },
      clearNotified: Boolean(upward),
    },
    now,
  );

  summary.processed += 1;

  const chatId =
    deps.notify === false
      ? undefined
      : hasTelegram(deps.config)
        ? requireTelegram(deps.config).chatId
        : undefined;

  const result = await applyClassification(
    {
      config: deps.config,
      db: deps.db,
      telegram: deps.notify === false ? undefined : deps.telegram,
      chatId,
      notion: deps.notion,
      fetch: deps.fetch,
      now,
      bodyText: msg.bodyText,
      log: deps.log,
    },
    mail,
    classified,
    {
      drive: match.kind === "one" ? match.drive : driveId ? drives.find((d) => d.id === driveId) ?? null : null,
      ambiguousCandidates: match.kind === "many" ? ambiguous : undefined,
      bodyText: msg.bodyText,
    },
  );

  if (result.notified) {
    summary.notified += 1;
  }
  if (result.skipped) {
    summary.skipped += 1;
  }
}

async function syncOneMailbox(
  deps: SyncRecruitmentMailDeps,
  account: MailAccount,
  client: GmailClient,
  studentTokens: string[],
  drives: Awaited<ReturnType<typeof listDrives>>,
  summary: MailSyncSummary,
  now: Date,
): Promise<void> {
  let cursor = await getMailSyncCursor(deps.db, account);
  let messageIds: string[] = [];
  let nextHistoryId: string | null = null;

  if (!cursor) {
    deps.log?.info?.({ account }, "mail bootstrap (no cursor)");
    const boot = await bootstrapMessageIds(client);
    if (!boot.ok) {
      deps.log?.warn?.({ account, reason: boot.reason }, "mail bootstrap failed");
      summary.alerts.push(`mail_bootstrap_${account}:${boot.reason}`);
      return;
    }
    messageIds = boot.ids;
    nextHistoryId = boot.historyId;
  } else {
    const hist = await client.listHistory(cursor);
    if (!hist.ok) {
      if (hist.stale) {
        deps.log?.warn?.({ account }, "mail history stale; re-bootstrap");
        const boot = await bootstrapMessageIds(client);
        if (!boot.ok) {
          summary.alerts.push(`mail_rebootstrap_${account}:${boot.reason}`);
          return;
        }
        messageIds = boot.ids;
        nextHistoryId = boot.historyId;
      } else {
        deps.log?.warn?.({ account, reason: hist.reason }, "mail history failed");
        summary.alerts.push(`mail_history_${account}:${hist.reason}`);
        return;
      }
    } else {
      messageIds = hist.messageIds;
      nextHistoryId = hist.historyId;
    }
  }

  for (const id of messageIds) {
    try {
      await processMessage(deps, account, client, id, studentTokens, drives, summary, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : "process error";
      deps.log?.warn?.({ account, messageId: id, reason: message }, "mail message failed");
      summary.alerts.push(`mail_msg_${account}:${message}`);
    }
  }

  if (nextHistoryId) {
    await setMailSyncCursor(deps.db, account, nextHistoryId, now);
  }
}

/**
 * Sync configured mailboxes for recruitment stage mail. Soft-fails per account.
 */
export async function syncRecruitmentMail(
  deps: SyncRecruitmentMailDeps,
): Promise<MailSyncSummary> {
  const now = deps.now ?? new Date();
  const summary: MailSyncSummary = {
    ok: true,
    accounts: 0,
    processed: 0,
    notified: 0,
    skipped: 0,
    alerts: [],
  };

  const clientLog =
    deps.log?.info && deps.log?.warn
      ? { info: deps.log.info, warn: deps.log.warn }
      : undefined;

  const mailboxes =
    deps.mailboxes ??
    listConfiguredMailboxes(deps.config, { fetch: deps.fetch, log: clientLog });

  if (mailboxes.length === 0) {
    deps.log?.warn?.({}, "no gmail mailboxes configured; mail sync skipped");
    return summary;
  }

  let telegram = deps.telegram;
  if (!telegram && deps.notify !== false && hasTelegram(deps.config)) {
    const tg = requireTelegram(deps.config);
    telegram = new TelegramClient({
      botToken: tg.botToken,
      fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
      log: clientLog,
    });
  }

  const profile = await loadPlatformProfile(deps.db);
  const studentTokens = profile ? nameTokensFromProfile(profile.platform) : [];
  const drives = await listDrives(deps.db);

  const runDeps: SyncRecruitmentMailDeps = { ...deps, telegram, now };

  for (const box of mailboxes) {
    summary.accounts += 1;
    try {
      await syncOneMailbox(runDeps, box.account, box.client, studentTokens, drives, summary, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : "mailbox error";
      deps.log?.warn?.({ account: box.account, reason: message }, "mail mailbox failed");
      summary.alerts.push(`mail_account_${box.account}:${message}`);
    }
  }

  deps.log?.info?.(
    {
      accounts: summary.accounts,
      processed: summary.processed,
      notified: summary.notified,
      skipped: summary.skipped,
      alertCount: summary.alerts.length,
    },
    "mail sync complete",
  );

  return summary;
}
