import type { Config } from "../config.ts";
import { requirePlacementCredentials, requireSupabase } from "../config.ts";
import { createDbClient, type DbClient } from "../db/client.ts";
import {
  listDrives,
  markNotApplied,
  setDetail,
  setPdfText,
  touchLastSeen,
  upsertFromList,
  type DriveRow,
} from "../db/drive.ts";
import { loadPlatformProfile } from "../db/profile.ts";
import { clearBearerToken, loadBearerToken } from "../db/secret.ts";
import { PlacementClient, type CatalogEvent, type PlacementLogger } from "../placement/client.ts";
import { buildEligibilityBody } from "../placement/eligibilityBody.ts";
import { downloadPdf } from "../pdf/download.ts";
import { extractPdfText } from "../pdf/extract.ts";
import { diffCatalog, eventDisplayFields, extractPdfUrls, type DiffAction } from "./diff.ts";

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

  const secret = await loadBearerToken(db);
  if (!secret.bearerToken) {
    log?.warn({ alert: "no_token" }, "poll skipped");
    return emptySummary({ ok: false, alert: "no_token", alerts });
  }

  const profile = await loadPlatformProfile(db);
  if (!profile) {
    log?.warn({ alert: "no_profile" }, "poll skipped");
    return emptySummary({ ok: false, alert: "no_profile", alerts });
  }

  const { body } = buildEligibilityBody(profile.platform);
  const list = await placement.getEventsByStudentEligibility(secret.bearerToken, body);
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

  const touchIds: string[] = [];
  const notAppliedIds: string[] = [];

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
    await applyListUpsert(db, action, now);
    if (action.kind === "insert") {
      inserted += 1;
    } else {
      refreshed += 1;
    }

    const urls = extractPdfUrls(action.event);
    let detail: CatalogEvent | Record<string, unknown> = action.event;

    if (action.fetchDetail) {
      const detailOutcome = await placement.getEventDetails(secret.bearerToken, action.id);
      if (detailOutcome.kind === "ok") {
        detail = detailOutcome.data;
        await setDetail(db, action.id, detail as Record<string, unknown>, now);
        detailsFetched += 1;
        const detailUrls = extractPdfUrls(detail);
        if (detailUrls.length > 0) {
          // Prefer detail URL set when present.
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

    const prior = existingById.get(action.id);
    const priorText = prior?.pdf_text ?? {};
    const pdfResult = await ensurePdfs(action.id, urls, priorText, fetchImpl, log);
    alerts.push(...pdfResult.alerts);
    pdfsFetched += pdfResult.fetched;
    if (pdfResult.fetched > 0 || urls.join("\0") !== (prior?.pdf_urls ?? []).join("\0")) {
      await setPdfText(db, action.id, urls, pdfResult.pdfText, now);
    }
  }

  await touchLastSeen(db, touchIds, now);
  await markNotApplied(db, notAppliedIds, now);
  notApplied = notAppliedIds.length;

  log?.info(
    {
      inserted,
      refreshed,
      touched,
      notApplied,
      detailsFetched,
      pdfsFetched,
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
