import { renewFromUnauthorized } from "../auth/renew.ts";
import type { Config } from "../config.ts";
import { syncSubEventsForDrive } from "../calendar/syncSubEvents.ts";
import {
  hasCalendarPersonal,
  hasNotion,
  hasTelegram,
  requireNotion,
  requirePlacementCredentials,
  requireSupabase,
  requireTelegram,
} from "../config.ts";
import { createDbClient, type DbClient } from "../db/client.ts";
import {
  getDrive,
  listDrives,
  markNotApplied,
  setDetail,
  setPdfText,
  touchLastSeen,
  upsertFromList,
  type DriveRow,
} from "../db/drive.ts";
import { loadPlatformProfile, upsertPlatformProfile } from "../db/profile.ts";
import { clearBearerToken, loadBearerToken } from "../db/secret.ts";
import { NotionClient } from "../notion/client.ts";
import { syncEligibleDrives } from "../notion/sync.ts";
import { PlacementClient, type CatalogEvent, type PlacementLogger } from "../placement/client.ts";
import { buildEligibilityBody } from "../placement/eligibilityBody.ts";
import { downloadPdf } from "../pdf/download.ts";
import { extractPdfText } from "../pdf/extract.ts";
import { TelegramClient } from "../telegram/client.ts";
import { shouldAlert } from "../telegram/dedup.ts";
import { notifyEligibleDrive } from "../telegram/notify.ts";
import { syncRecruitmentMail } from "../mail/sync.ts";
import { runDailyApplyPass } from "./dailyApply.ts";
import { diffCatalog, eventDisplayFields, extractPdfUrls, type DiffAction } from "./diff.ts";
import { sendDeadlineReminders } from "./reminders.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export type PollSummary = {
  ok: boolean;
  alert?: string;
  alerts: string[];
  inserted: number;
  refreshed: number;
  touched: number;
  notApplied: number;
  detailsFetched: number;
  pdfsFetched: number;
  notified: number;
  notionSynced: number;
  reminded: number;
  applyChecked: number;
  markedApplied: number;
  mailProcessed?: number;
  mailNotified?: number;
};

export type PollLogger = PlacementLogger & {
  error?: (obj: Record<string, unknown>, msg?: string) => void;
};

export type RunPollDeps = {
  config: Config;
  log?: PollLogger;
  db?: DbClient;
  placement?: PlacementClient;
  fetch?: typeof globalThis.fetch;
  now?: Date;
  /** Test seam: override existing drives instead of reading Supabase. */
  listExisting?: (db: DbClient) => Promise<DriveRow[]>;
  /** Test seam: inject Telegram client (skip real Bot API). */
  telegram?: TelegramClient;
  /** Test seam: inject Notion client (skip real Notion API). */
  notion?: NotionClient;
  /** When false, skip notify even if Telegram env is set. */
  notify?: boolean;
  /** When false, skip Notion sync even if Notion env is set. */
  notionSync?: boolean;
  /** When false, skip under-6h reminder pass. */
  reminders?: boolean;
  /** When false, skip daily checkApplyStatus pass. */
  dailyApply?: boolean;
  /** When false, skip Gmail recruitment mail pass. */
  mailSync?: boolean;
  /** Internal: true after one renewal retry of the full poll. */
  alreadyRetried?: boolean;
};

function emptySummary(partial: Partial<PollSummary> & { ok: boolean }): PollSummary {
  return {
    alerts: [],
    inserted: 0,
    refreshed: 0,
    touched: 0,
    notApplied: 0,
    detailsFetched: 0,
    pdfsFetched: 0,
    notified: 0,
    notionSynced: 0,
    reminded: 0,
    applyChecked: 0,
    markedApplied: 0,
    ...partial,
  };
}

async function ensurePdfs(
  driveId: string,
  urls: string[],
  existingText: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
  log: PollLogger | undefined,
): Promise<{ pdfText: Record<string, string>; fetched: number; alerts: string[] }> {
  const pdfText = { ...existingText };
  let fetched = 0;
  const alerts: string[] = [];

  for (const url of urls) {
    if (pdfText[url] !== undefined) {
      continue;
    }
    const downloaded = await downloadPdf(url, { fetch: fetchImpl });
    if (!downloaded.ok) {
      alerts.push(`pdf_download:${driveId}`);
      log?.warn({ driveId, reason: downloaded.reason }, "pdf download failed");
      continue;
    }
    const extracted = await extractPdfText(downloaded.bytes);
    if (!extracted.ok) {
      alerts.push(`pdf_extract:${driveId}`);
      log?.warn({ driveId, reason: extracted.reason }, "pdf extract failed");
      continue;
    }
    pdfText[url] = extracted.text;
    fetched += 1;
  }

  // Drop text for URLs no longer present.
  for (const key of Object.keys(pdfText)) {
    if (!urls.includes(key)) {
      delete pdfText[key];
    }
  }

  return { pdfText, fetched, alerts };
}

export async function runPoll(deps: RunPollDeps): Promise<PollSummary> {
  const now = deps.now ?? new Date();
  const log = deps.log;
  const alerts: string[] = [];

  let supabase;
  try {
    supabase = requireSupabase(deps.config);
    requirePlacementCredentials(deps.config);
  } catch (error) {
    const message = error instanceof Error ? error.message : "missing config";
    log?.warn({ alert: message }, "poll skipped");
    return emptySummary({ ok: false, alert: message, alerts });
  }

  const db = deps.db ?? createDbClient(supabase.url, supabase.serviceRoleKey);
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);

  const placement =
    deps.placement ??
    new PlacementClient({
      fetch: fetchImpl,
      log,
      onUnauthorized: async () => {
        await clearBearerToken(db);
      },
    });

  let telegramClient: TelegramClient | undefined = deps.telegram;
  if (!telegramClient && hasTelegram(deps.config)) {
    const tg = requireTelegram(deps.config);
    telegramClient = new TelegramClient({
      botToken: tg.botToken,
      fetch: fetchImpl,
      log,
    });
  }

  const tryRenewAndRetry = async (reason: string): Promise<PollSummary> => {
    const renew = await renewFromUnauthorized({
      config: deps.config,
      db,
      placement,
      telegram: telegramClient,
      log,
      now,
    });
    if (renew.kind === "renewed" && !deps.alreadyRetried) {
      log?.info({ alert: reason, renew: "retrying" }, "session renewed; retrying poll once");
      return runPoll({ ...deps, alreadyRetried: true, db, placement, telegram: telegramClient });
    }
    if (renew.kind === "waiting" || renew.kind === "awaiting_otp") {
      log?.warn({ alert: renew.kind }, "poll waiting on login approval/OTP");
      return emptySummary({
        ok: false,
        alert: renew.kind === "waiting" ? "awaiting_login_approval" : "awaiting_otp",
        alerts,
      });
    }
    if (renew.kind === "renewed" && deps.alreadyRetried) {
      log?.warn({ alert: "renew_retry_exhausted" }, "renewed but already retried");
      return emptySummary({ ok: false, alert: "renew_retry_exhausted", alerts });
    }
    log?.warn(
      { alert: reason, renew: renew.kind, detail: renew.kind === "failed" ? renew.reason : undefined },
      "renew failed",
    );
    return emptySummary({ ok: false, alert: reason, alerts });
  };

  let secret = await loadBearerToken(db);
  if (!secret.bearerToken) {
    return tryRenewAndRetry("no_token");
  }

  let profile = await loadPlatformProfile(db);
  if (!profile) {
    log?.warn({ alert: "no_profile" }, "poll skipped");
    return emptySummary({ ok: false, alert: "no_profile", alerts });
  }

  // Daily profile refresh while the token works.
  const syncedAtMs = profile.platformSyncedAt ? Date.parse(profile.platformSyncedAt) : 0;
  if (!Number.isFinite(syncedAtMs) || now.getTime() - syncedAtMs > DAY_MS) {
    const student = await placement.getStudent(secret.bearerToken, profile.studentId);
    if (student.kind === "unauthorized") {
      return tryRenewAndRetry("unauthorized");
    } else if (student.kind === "ok") {
      await upsertPlatformProfile(db, profile.studentId, student.data, now);
      profile = (await loadPlatformProfile(db)) ?? profile;
    } else {
      alerts.push(`profile_refresh:${student.kind}`);
      log?.warn({ outcome: student.kind }, "daily getStudent failed");
    }
  }

  const { body } = buildEligibilityBody(profile.platform);
  secret = await loadBearerToken(db);
  if (!secret.bearerToken) {
    return tryRenewAndRetry("no_token");
  }

  const list = await placement.getEventsByStudentEligibility(secret.bearerToken, body);
  if (list.kind === "unauthorized") {
    return tryRenewAndRetry("unauthorized");
  }
  if (list.kind !== "ok") {
    log?.warn({ alert: list.kind }, "catalog list failed; keeping prior drives");
    return emptySummary({ ok: false, alert: list.kind, alerts });
  }

  const existing = deps.listExisting ? await deps.listExisting(db) : await listDrives(db);
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const { actions, alerts: diffAlerts } = diffCatalog(list.data.events, existing, now);
  alerts.push(...diffAlerts);

  let inserted = 0;
  let refreshed = 0;
  let touched = 0;
  let notApplied = 0;
  let detailsFetched = 0;
  let pdfsFetched = 0;
  let notified = 0;
  let notionSynced = 0;
  let reminded = 0;
  let applyChecked = 0;
  let markedApplied = 0;

  const touchIds: string[] = [];
  const notAppliedIds: string[] = [];
  const notifyCandidates: DiffAction[] = [];

  for (const action of actions) {
    if (action.kind === "touch") {
      touchIds.push(action.id);
      touched += 1;
      continue;
    }
    if (action.kind === "markNotApplied") {
      notAppliedIds.push(action.id);
      continue;
    }
    if (!action.event) {
      continue;
    }
    const prior = existingById.get(action.id);
    await applyListUpsert(db, action, now);
    if (action.kind === "insert") {
      inserted += 1;
    } else {
      refreshed += 1;
    }

    const urls = extractPdfUrls(action.event);

    if (action.fetchDetail) {
      let detailOutcome = await placement.getEventDetails(secret.bearerToken!, action.id);
      if (detailOutcome.kind === "unauthorized") {
        const renew = await renewFromUnauthorized({
          config: deps.config,
          db,
          placement,
          telegram: telegramClient,
          log,
          now,
        });
        if (renew.kind === "renewed") {
          secret = await loadBearerToken(db);
          if (secret.bearerToken) {
            detailOutcome = await placement.getEventDetails(secret.bearerToken, action.id);
          }
        } else if (renew.kind === "waiting" || renew.kind === "awaiting_otp") {
          log?.warn({ alert: renew.kind }, "detail 401 entered login wait; stopping placement calls");
          return emptySummary({
            ok: false,
            alert: renew.kind === "waiting" ? "awaiting_login_approval" : "awaiting_otp",
            alerts,
            inserted,
            refreshed,
            touched,
            notApplied,
            detailsFetched,
            pdfsFetched,
          });
        }
      }
      if (detailOutcome.kind === "ok") {
        const detail = detailOutcome.data;
        await setDetail(db, action.id, detail as Record<string, unknown>, now);
        detailsFetched += 1;
        if (hasCalendarPersonal(deps.config)) {
          try {
            const cal = await syncSubEventsForDrive({
              config: deps.config,
              db,
              driveId: action.id,
              fetch: fetchImpl,
              now,
              log,
            });
            if (cal.created > 0) {
              log?.info?.(
                { driveId: action.id, created: cal.created },
                "subEvent calendar sync",
              );
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "calendar error";
            log?.warn?.({ driveId: action.id, reason: message }, "subEvent calendar sync failed");
            alerts.push(`calendar:${action.id}`);
          }
        }
        const detailUrls = extractPdfUrls(detail);
        if (detailUrls.length > 0) {
          for (const url of detailUrls) {
            if (!urls.includes(url)) {
              urls.push(url);
            }
          }
        }
      } else {
        alerts.push(`detail:${action.id}:${detailOutcome.kind}`);
        log?.warn({ driveId: action.id, outcome: detailOutcome.kind }, "detail fetch failed");
      }
    }

    const priorText = prior?.pdf_text ?? {};
    const pdfResult = await ensurePdfs(action.id, urls, priorText, fetchImpl, log);
    alerts.push(...pdfResult.alerts);
    pdfsFetched += pdfResult.fetched;
    if (pdfResult.fetched > 0 || urls.join("\0") !== (prior?.pdf_urls ?? []).join("\0")) {
      await setPdfText(db, action.id, urls, pdfResult.pdfText, now);
    }

    notifyCandidates.push(action);
  }

  await touchLastSeen(db, touchIds, now);
  await markNotApplied(db, notAppliedIds, now);
  notApplied = notAppliedIds.length;

  const wantNotify = deps.notify !== false;
  if (wantNotify && notifyCandidates.length > 0) {
    if (!hasTelegram(deps.config)) {
      log?.warn({ alert: "telegram_skipped" }, "telegram env missing; persistence ok");
      alerts.push("telegram_skipped");
    } else {
      const tg = requireTelegram(deps.config);
      telegramClient =
        telegramClient ??
        new TelegramClient({
          botToken: tg.botToken,
          fetch: fetchImpl,
          log,
        });
      for (const action of notifyCandidates) {
        const previous = existingById.get(action.id);
        const next = await getDrive(db, action.id);
        if (!next) {
          continue;
        }
        if (!shouldAlert({ action, previous, next })) {
          continue;
        }
        const result = await notifyEligibleDrive(
          { db, telegram: telegramClient, chatId: tg.chatId, now },
          next,
        );
        if (result.ok) {
          notified += 1;
        } else {
          alerts.push(`telegram_send:${action.id}`);
          log?.warn({ driveId: action.id, reason: result.reason }, "telegram notify failed");
        }
      }
    }
  }

  if (deps.reminders !== false) {
    if (!hasTelegram(deps.config)) {
      alerts.push("reminder_skipped");
    } else {
      const tg = requireTelegram(deps.config);
      telegramClient =
        telegramClient ??
        new TelegramClient({
          botToken: tg.botToken,
          fetch: fetchImpl,
          log,
        });
      const reminderResult = await sendDeadlineReminders({
        db,
        telegram: telegramClient,
        chatId: tg.chatId,
        now,
      });
      reminded = reminderResult.reminded;
      alerts.push(...reminderResult.alerts);
    }
  }

  if (deps.dailyApply !== false) {
    const notionCfg = hasNotion(deps.config) ? requireNotion(deps.config) : null;
    const notionForApply =
      deps.notion ??
      (notionCfg
        ? new NotionClient({
            token: notionCfg.token,
            fetch: fetchImpl,
            log,
          })
        : undefined);
    const daily = await runDailyApplyPass({
      config: deps.config,
      db,
      placement,
      notion: notionForApply,
      telegram: telegramClient,
      chatId: hasTelegram(deps.config) ? requireTelegram(deps.config).chatId : undefined,
      fetch: fetchImpl,
      log,
      now,
    });
    applyChecked = daily.applyChecked;
    markedApplied = daily.markedApplied;
    alerts.push(...daily.alerts);
  }

  const wantNotion = deps.notionSync !== false;
  if (wantNotion) {
    if (!hasNotion(deps.config)) {
      log?.warn({ alert: "notion_skipped" }, "notion env missing; persistence ok");
      alerts.push("notion_skipped");
    } else {
      const notionCfg = requireNotion(deps.config);
      const notion =
        deps.notion ??
        new NotionClient({
          token: notionCfg.token,
          fetch: fetchImpl,
          log,
        });
      if (!telegramClient && hasTelegram(deps.config)) {
        const tg = requireTelegram(deps.config);
        telegramClient = new TelegramClient({
          botToken: tg.botToken,
          fetch: fetchImpl,
          log,
        });
      }
      const tgChatId = hasTelegram(deps.config) ? requireTelegram(deps.config).chatId : undefined;
      const notionResult = await syncEligibleDrives({
        db,
        notion,
        databaseId: notionCfg.databaseId,
        now,
        log,
        telegram: telegramClient,
        chatId: tgChatId,
        candidateIds: notifyCandidates.map((a) => a.id),
        notAppliedIds,
      });
      notionSynced = notionResult.synced;
      alerts.push(...notionResult.alerts);
    }
  }

  let mailProcessed = 0;
  let mailNotified = 0;
  if (deps.mailSync !== false) {
    try {
      const mailResult = await syncRecruitmentMail({
        config: deps.config,
        db,
        log,
        fetch: fetchImpl,
        now,
        telegram: telegramClient,
        notion: deps.notion,
        notify: deps.notify !== false,
      });
      mailProcessed = mailResult.processed;
      mailNotified = mailResult.notified;
      alerts.push(...mailResult.alerts);
    } catch (error) {
      const message = error instanceof Error ? error.message : "mail sync error";
      log?.warn?.({ reason: message }, "mail sync failed; poll continues");
      alerts.push(`mail_sync:${message}`);
    }
  }

  log?.info(
    {
      inserted,
      refreshed,
      touched,
      notApplied,
      detailsFetched,
      pdfsFetched,
      notified,
      notionSynced,
      reminded,
      applyChecked,
      markedApplied,
      mailProcessed,
      mailNotified,
      alertCount: alerts.length,
    },
    "poll complete",
  );

  return {
    ok: true,
    alerts,
    inserted,
    refreshed,
    touched,
    notApplied,
    detailsFetched,
    pdfsFetched,
    notified,
    notionSynced,
    reminded,
    applyChecked,
    markedApplied,
    mailProcessed,
    mailNotified,
  };
}

async function applyListUpsert(db: DbClient, action: DiffAction, now: Date): Promise<void> {
  const event = action.event;
  if (!event) {
    return;
  }
  const display = eventDisplayFields(event);
  await upsertFromList(
    db,
    {
      id: action.id,
      rawList: event as Record<string, unknown>,
      updatedAtPlatform: display.updatedAtPlatform,
      isEligible: action.isEligible,
      deadline: display.deadline,
      statusOnInsert: action.statusOnInsert,
      setStatusNewIfNull: action.setStatusNewIfNull,
      companyId: display.companyId,
      companyName: display.companyName,
      companyUsername: display.companyUsername,
      eventName: display.eventName,
      pdfUrls: extractPdfUrls(event),
    },
    now,
  );
}
