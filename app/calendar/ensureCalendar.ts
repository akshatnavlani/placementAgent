import type { DbClient } from "../db/client.ts";
import { clearCalendarSync, getCalendarSync, setCalendarSync } from "../db/calendar.ts";
import {
  CalendarClient,
  PLACEMENTS_CALENDAR_SUMMARY,
  type CalendarOutcome,
} from "./client.ts";

export type EnsureCalendarDeps = {
  db: DbClient;
  client: CalendarClient;
  now?: Date;
  log?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
};

/**
 * Resolve the placements calendar id: reuse calendar_sync, else find by summary,
 * else create. Never returns primary.
 */
export async function ensurePlacementsCalendar(
  deps: EnsureCalendarDeps,
): Promise<CalendarOutcome<{ calendarId: string }>> {
  const now = deps.now ?? new Date();
  const stored = await getCalendarSync(deps.db);
  if (stored?.google_calendar_id && stored.google_calendar_id !== "primary") {
    const probe = await deps.client.getCalendar(stored.google_calendar_id);
    if (probe.ok) {
      return { ok: true, value: { calendarId: stored.google_calendar_id } };
    }
    if (probe.notFound) {
      deps.log?.info?.({ calendarId: stored.google_calendar_id }, "calendar_sync stale; re-resolving");
      await clearCalendarSync(deps.db);
    } else {
      return { ok: false, reason: probe.reason };
    }
  }

  const listed = await deps.client.listCalendarSummaries();
  if (!listed.ok) {
    return listed;
  }
  const match = listed.value.find(
    (c) => c.summary === PLACEMENTS_CALENDAR_SUMMARY && c.id !== "primary",
  );
  if (match) {
    await setCalendarSync(
      deps.db,
      { googleCalendarId: match.id, calendarSummary: PLACEMENTS_CALENDAR_SUMMARY },
      now,
    );
    return { ok: true, value: { calendarId: match.id } };
  }

  const created = await deps.client.createCalendar(PLACEMENTS_CALENDAR_SUMMARY);
  if (!created.ok) {
    return created;
  }
  if (created.value.id === "primary") {
    return { ok: false, reason: "refusing primary calendar id" };
  }
  await setCalendarSync(
    deps.db,
    { googleCalendarId: created.value.id, calendarSummary: PLACEMENTS_CALENDAR_SUMMARY },
    now,
  );
  deps.log?.info?.({ calendarId: created.value.id }, "created placements calendar");
  return { ok: true, value: { calendarId: created.value.id } };
}
