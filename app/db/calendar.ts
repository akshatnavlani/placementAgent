import type { DbClient } from "./client.ts";

export type CalendarRoundKey = "assessment" | "interview";
export type CalendarEventSource = "mail" | "subevent";
export type CalendarEventStatus = "active" | "cancelled";

export type CalendarSyncRow = {
  id: string;
  google_calendar_id: string;
  calendar_summary: string;
  updated_at: string;
};

export type CalendarEventRow = {
  id: string;
  drive_id: string;
  round_key: CalendarRoundKey;
  google_event_id: string;
  source: CalendarEventSource;
  status: CalendarEventStatus;
  start_at: string | null;
  end_at: string | null;
  title: string;
  created_at: string;
  updated_at: string;
};

const SYNC_ID = "personal";

function mapSync(row: Record<string, unknown>): CalendarSyncRow {
  return {
    id: String(row.id),
    google_calendar_id: String(row.google_calendar_id),
    calendar_summary: typeof row.calendar_summary === "string" ? row.calendar_summary : "placements",
    updated_at: String(row.updated_at),
  };
}

function mapEvent(row: Record<string, unknown>): CalendarEventRow {
  return {
    id: String(row.id),
    drive_id: String(row.drive_id),
    round_key: row.round_key as CalendarRoundKey,
    google_event_id: String(row.google_event_id),
    source: row.source as CalendarEventSource,
    status: row.status as CalendarEventStatus,
    start_at: (row.start_at as string | null) ?? null,
    end_at: (row.end_at as string | null) ?? null,
    title: typeof row.title === "string" ? row.title : "",
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function getCalendarSync(db: DbClient): Promise<CalendarSyncRow | null> {
  const { data, error } = await db.from("calendar_sync").select("*").eq("id", SYNC_ID).maybeSingle();
  if (error) {
    throw new Error(`calendar_sync get failed: ${error.message}`);
  }
  return data ? mapSync(data as Record<string, unknown>) : null;
}

export async function setCalendarSync(
  db: DbClient,
  input: { googleCalendarId: string; calendarSummary?: string },
  now: Date = new Date(),
): Promise<CalendarSyncRow> {
  const iso = now.toISOString();
  const { data, error } = await db
    .from("calendar_sync")
    .upsert(
      {
        id: SYNC_ID,
        google_calendar_id: input.googleCalendarId,
        calendar_summary: input.calendarSummary ?? "placements",
        updated_at: iso,
      },
      { onConflict: "id" },
    )
    .select("*")
    .single();
  if (error) {
    throw new Error(`calendar_sync set failed: ${error.message}`);
  }
  return mapSync(data as Record<string, unknown>);
}

export async function clearCalendarSync(db: DbClient): Promise<void> {
  const { error } = await db.from("calendar_sync").delete().eq("id", SYNC_ID);
  if (error) {
    throw new Error(`calendar_sync clear failed: ${error.message}`);
  }
}

export async function getCalendarEvent(
  db: DbClient,
  driveId: string,
  roundKey: CalendarRoundKey,
): Promise<CalendarEventRow | null> {
  const { data, error } = await db
    .from("calendar_event")
    .select("*")
    .eq("drive_id", driveId)
    .eq("round_key", roundKey)
    .maybeSingle();
  if (error) {
    throw new Error(`calendar_event get failed: ${error.message}`);
  }
  return data ? mapEvent(data as Record<string, unknown>) : null;
}

export async function listActiveCalendarEventsForDrive(
  db: DbClient,
  driveId: string,
): Promise<CalendarEventRow[]> {
  const { data, error } = await db
    .from("calendar_event")
    .select("*")
    .eq("drive_id", driveId)
    .eq("status", "active");
  if (error) {
    throw new Error(`calendar_event listActive failed: ${error.message}`);
  }
  return (data ?? []).map((row) => mapEvent(row as Record<string, unknown>));
}

export async function upsertCalendarEvent(
  db: DbClient,
  input: {
    driveId: string;
    roundKey: CalendarRoundKey;
    googleEventId: string;
    source: CalendarEventSource;
    status?: CalendarEventStatus;
    startAt?: Date | null;
    endAt?: Date | null;
    title?: string;
  },
  now: Date = new Date(),
): Promise<CalendarEventRow> {
  const iso = now.toISOString();
  const existing = await getCalendarEvent(db, input.driveId, input.roundKey);
  const payload = {
    drive_id: input.driveId,
    round_key: input.roundKey,
    google_event_id: input.googleEventId,
    source: input.source,
    status: input.status ?? "active",
    start_at: input.startAt ? input.startAt.toISOString() : null,
    end_at: input.endAt ? input.endAt.toISOString() : null,
    title: input.title ?? "",
    updated_at: iso,
  };
  if (existing) {
    const { data, error } = await db
      .from("calendar_event")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) {
      throw new Error(`calendar_event update failed: ${error.message}`);
    }
    return mapEvent(data as Record<string, unknown>);
  }
  const { data, error } = await db
    .from("calendar_event")
    .insert({ ...payload, created_at: iso })
    .select("*")
    .single();
  if (error) {
    throw new Error(`calendar_event insert failed: ${error.message}`);
  }
  return mapEvent(data as Record<string, unknown>);
}

export async function markCalendarCancelled(
  db: DbClient,
  driveId: string,
  roundKey: CalendarRoundKey,
  now: Date = new Date(),
): Promise<CalendarEventRow | null> {
  const existing = await getCalendarEvent(db, driveId, roundKey);
  if (!existing) {
    return null;
  }
  const { data, error } = await db
    .from("calendar_event")
    .update({ status: "cancelled", updated_at: now.toISOString() })
    .eq("id", existing.id)
    .select("*")
    .single();
  if (error) {
    throw new Error(`calendar_event cancel failed: ${error.message}`);
  }
  return mapEvent(data as Record<string, unknown>);
}
