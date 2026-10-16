import { hasCalendarPersonal, requireCalendarPersonal, type Config } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import {
  getCalendarEvent,
  listActiveCalendarEventsForDrive,
  markCalendarCancelled,
  upsertCalendarEvent,
  type CalendarEventSource,
  type CalendarRoundKey,
} from "../db/calendar.ts";
import type { DriveRow } from "../db/drive.ts";
import type { MailClassification } from "../db/mail.ts";
import { CalendarClient } from "./client.ts";
import { ensurePlacementsCalendar } from "./ensureCalendar.ts";
import {
  inferRoundKeyFromText,
  roundKeyFromClassification,
  roundKeyLabel,
} from "./roundKey.ts";
import { resolveEventTime } from "./resolveTime.ts";

export type CalendarSyncAction = "create" | "reschedule" | "cancel";

export type SyncEventResult = {
  ok: boolean;
  action: CalendarSyncAction | "skip";
  reason: string;
  roundKey?: CalendarRoundKey;
  googleEventId?: string;
  startAt?: Date;
  endAt?: Date;
};

export type SyncEventDeps = {
  config: Config;
  db: DbClient;
  drive: DriveRow;
  classification: MailClassification;
  subject?: string;
  body?: string;
  fetch?: typeof globalThis.fetch;
  now?: Date;
  calendar?: CalendarClient;
  log?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
};

function eventTitle(drive: DriveRow, roundKey: CalendarRoundKey): string {
  const company = drive.company_name?.trim() || "Unknown";
  const round = roundKeyLabel(roundKey);
  const role = drive.event_name?.trim();
  return role ? `${company} — ${round} (${role})` : `${company} — ${round}`;
}

function eventDescription(subject: string | undefined, venue: string | undefined): string {
  const parts: string[] = [];
  if (subject?.trim()) {
    parts.push(subject.trim().slice(0, 200));
  }
  if (venue?.trim()) {
    parts.push(`Venue: ${venue.trim()}`);
  }
  return parts.join("\n");
}

function classifyAction(classification: MailClassification): CalendarSyncAction | null {
  if (classification === "assessment" || classification === "interview") {
    return "create";
  }
  if (classification === "reschedule") {
    return "reschedule";
  }
  if (classification === "cancel") {
    return "cancel";
  }
  return null;
}

async function resolveRoundKey(
  deps: SyncEventDeps,
  action: CalendarSyncAction,
): Promise<CalendarRoundKey | null> {
  const fromClass = roundKeyFromClassification(deps.classification);
  if (fromClass) {
    return fromClass;
  }
  const text = `${deps.subject ?? ""}\n${deps.body ?? ""}`;
  const inferred = inferRoundKeyFromText(text);
  if (inferred) {
    return inferred;
  }
  if (action === "reschedule" || action === "cancel") {
    const active = await listActiveCalendarEventsForDrive(deps.db, deps.drive.id);
    const interview = active.find((e) => e.round_key === "interview");
    if (interview) {
      return "interview";
    }
    const assessment = active.find((e) => e.round_key === "assessment");
    if (assessment) {
      return "assessment";
    }
  }
  return null;
}

export async function syncCalendarEvent(deps: SyncEventDeps): Promise<SyncEventResult> {
  const action = classifyAction(deps.classification);
  if (!action) {
    return { ok: true, action: "skip", reason: "not_calendar_classification" };
  }
  if (!hasCalendarPersonal(deps.config)) {
    return { ok: true, action: "skip", reason: "calendar_not_configured" };
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
    deps.log?.warn?.({ reason: calendar.reason }, "ensure placements calendar failed");
    return { ok: false, action, reason: calendar.reason };
  }
  const calendarId = calendar.value.calendarId;
  if (calendarId === "primary") {
    return { ok: false, action, reason: "refusing primary calendar" };
  }

  const roundKey = await resolveRoundKey(deps, action);
  if (!roundKey) {
    return { ok: false, action, reason: "unknown_round" };
  }

  if (action === "cancel") {
    const existing = await getCalendarEvent(deps.db, deps.drive.id, roundKey);
    if (!existing || existing.status === "cancelled") {
      return { ok: true, action: "cancel", reason: "already_cancelled", roundKey };
    }
    const deleted = await client.deleteEvent(calendarId, existing.google_event_id);
    if (!deleted.ok) {
      deps.log?.warn?.({ reason: deleted.reason }, "calendar delete failed");
      return { ok: false, action: "cancel", reason: deleted.reason, roundKey };
    }
    await markCalendarCancelled(deps.db, deps.drive.id, roundKey, now);
    return {
      ok: true,
      action: "cancel",
      reason: "cancelled",
      roundKey,
      googleEventId: existing.google_event_id,
    };
  }

  const resolved = resolveEventTime({
    roundKey,
    subject: deps.subject,
    body: deps.body,
    rawDetail: deps.drive.raw_detail,
    now,
  });
  if (!resolved) {
    return { ok: true, action, reason: "no_calendar_time", roundKey };
  }

  const source: CalendarEventSource = resolved.source;
  const title = eventTitle(deps.drive, roundKey);
  const description = eventDescription(deps.subject, resolved.venue);
  const payload = {
    summary: title,
    description,
    start: resolved.start,
    end: resolved.end,
  };

  const existing = await getCalendarEvent(deps.db, deps.drive.id, roundKey);
  if (existing && existing.status === "active") {
    const updated = await client.updateEvent(calendarId, existing.google_event_id, payload);
    if (!updated.ok) {
      if (updated.notFound) {
        const created = await client.createEvent(calendarId, payload);
        if (!created.ok) {
          return { ok: false, action, reason: created.reason, roundKey };
        }
        await upsertCalendarEvent(
          deps.db,
          {
            driveId: deps.drive.id,
            roundKey,
            googleEventId: created.value.id,
            source,
            status: "active",
            startAt: resolved.start,
            endAt: resolved.end,
            title,
          },
          now,
        );
        return {
          ok: true,
          action,
          reason: action === "reschedule" ? "rescheduled_recreated" : "created",
          roundKey,
          googleEventId: created.value.id,
          startAt: resolved.start,
          endAt: resolved.end,
        };
      }
      return { ok: false, action, reason: updated.reason, roundKey };
    }
    await upsertCalendarEvent(
      deps.db,
      {
        driveId: deps.drive.id,
        roundKey,
        googleEventId: existing.google_event_id,
        source,
        status: "active",
        startAt: resolved.start,
        endAt: resolved.end,
        title,
      },
      now,
    );
    return {
      ok: true,
      action,
      reason: action === "reschedule" ? "rescheduled" : "updated",
      roundKey,
      googleEventId: existing.google_event_id,
      startAt: resolved.start,
      endAt: resolved.end,
    };
  }

  const created = await client.createEvent(calendarId, payload);
  if (!created.ok) {
    return { ok: false, action, reason: created.reason, roundKey };
  }
  await upsertCalendarEvent(
    deps.db,
    {
      driveId: deps.drive.id,
      roundKey,
      googleEventId: created.value.id,
      source,
      status: "active",
      startAt: resolved.start,
      endAt: resolved.end,
      title,
    },
    now,
  );
  return {
    ok: true,
    action,
    reason: action === "reschedule" ? "created" : "created",
    roundKey,
    googleEventId: created.value.id,
    startAt: resolved.start,
    endAt: resolved.end,
  };
}
