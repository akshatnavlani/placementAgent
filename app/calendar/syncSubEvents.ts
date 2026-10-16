import { hasCalendarPersonal, requireCalendarPersonal, type Config } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { getCalendarEvent, upsertCalendarEvent } from "../db/calendar.ts";
import { getDrive } from "../db/drive.ts";
import { CalendarClient } from "./client.ts";
import { ensurePlacementsCalendar } from "./ensureCalendar.ts";
import { roundKeyLabel } from "./roundKey.ts";
import { listAssessmentInterviewSubEvents } from "./subEventTime.ts";

export type SyncSubEventsResult = {
  created: number;
  skipped: number;
  reasons: string[];
};

export type SyncSubEventsDeps = {
  config: Config;
  db: DbClient;
  driveId: string;
  fetch?: typeof globalThis.fetch;
  now?: Date;
  calendar?: CalendarClient;
  log?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
};

/**
 * Create assessment/interview events from subEvents when no active calendar_event exists.
 * Does not overwrite mail-sourced active events. Never uses deadline.
 */
export async function syncSubEventsForDrive(
  deps: SyncSubEventsDeps,
): Promise<SyncSubEventsResult> {
  const result: SyncSubEventsResult = { created: 0, skipped: 0, reasons: [] };
  if (!hasCalendarPersonal(deps.config)) {
    result.skipped += 1;
    result.reasons.push("calendar_not_configured");
    return result;
  }

  const drive = await getDrive(deps.db, deps.driveId);
  if (!drive?.raw_detail) {
    result.skipped += 1;
    result.reasons.push("no_detail");
    return result;
  }

  const candidates = listAssessmentInterviewSubEvents(drive.raw_detail);
  if (candidates.length === 0) {
    result.skipped += 1;
    result.reasons.push("no_matching_subevents");
    return result;
  }

  const now = deps.now ?? new Date();
  const creds = requireCalendarPersonal(deps.config);
  const client =
    deps.calendar ??
    new CalendarClient({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: creds.refreshToken,
      fetch: deps.fetch,
      log: deps.log,
    });

  const calendar = await ensurePlacementsCalendar({
    db: deps.db,
    client,
    now,
    log: deps.log,
  });
  if (!calendar.ok) {
    result.reasons.push(calendar.reason);
    return result;
  }
  const calendarId = calendar.value.calendarId;
  if (calendarId === "primary") {
    result.reasons.push("refusing primary calendar");
    return result;
  }

  for (const { roundKey, time } of candidates) {
    const existing = await getCalendarEvent(deps.db, drive.id, roundKey);
    if (existing && existing.status === "active") {
      result.skipped += 1;
      result.reasons.push(`${roundKey}:mail_or_active_exists`);
      continue;
    }

    const company = drive.company_name?.trim() || "Unknown";
    const round = roundKeyLabel(roundKey);
    const role = drive.event_name?.trim();
    const title = role ? `${company} — ${round} (${role})` : `${company} — ${round}`;
    const description = time.venue ? `Venue: ${time.venue}` : time.name;

    const created = await client.createEvent(calendarId, {
      summary: title,
      description,
      start: time.start,
      end: time.end,
    });
    if (!created.ok) {
      deps.log?.warn?.(
        { driveId: drive.id, roundKey, reason: created.reason },
        "subEvent calendar create failed",
      );
      result.reasons.push(`${roundKey}:${created.reason}`);
      continue;
    }

    await upsertCalendarEvent(
      deps.db,
      {
        driveId: drive.id,
        roundKey,
        googleEventId: created.value.id,
        source: "subevent",
        status: "active",
        startAt: time.start,
        endAt: time.end,
        title,
      },
      now,
    );
    result.created += 1;
  }

  return result;
}
