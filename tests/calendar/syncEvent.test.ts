import { describe, expect, it, vi } from "vitest";
import { syncCalendarEvent } from "../../app/calendar/syncEvent.ts";
import type { Config } from "../../app/config.ts";
import type { DriveRow } from "../../app/db/drive.ts";

const config = {
  HOST: "0.0.0.0",
  PORT: 10000,
  LOG_LEVEL: "silent",
  CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "csecret",
  GOOGLE_REFRESH_TOKEN_PERSONAL: "refresh",
} as Config;

function drive(overrides: Partial<DriveRow> = {}): DriveRow {
  return {
    id: "drive-1",
    raw_list: {},
    raw_detail: null,
    updated_at_platform: null,
    is_eligible: true,
    deadline: "2026-12-01T00:00:00.000Z",
    status: "Applied",
    reminder_sent: false,
    draft_status: null,
    notion_page_id: null,
    pdf_urls: [],
    pdf_text: {},
    company_id: null,
    company_name: "Acme",
    company_username: null,
    event_name: "SDE",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    alerted_at: null,
    applied_at: null,
    last_apply_check_at: null,
    ...overrides,
  };
}

type EventRow = {
  id: string;
  drive_id: string;
  round_key: string;
  google_event_id: string;
  source: string;
  status: string;
  start_at: string | null;
  end_at: string | null;
  title: string;
  created_at: string;
  updated_at: string;
};

function calendarDbFixed(events: EventRow[] = []) {
  let sync: { google_calendar_id: string; calendar_summary: string } | null = {
    google_calendar_id: "cal-placements",
    calendar_summary: "placements",
  };

  function filterEvents(filters: Record<string, string>): EventRow[] {
    return events.filter((e) =>
      Object.entries(filters).every(([k, v]) => (e as Record<string, string>)[k] === v),
    );
  }

  return {
    events,
    from(table: string) {
      if (table === "calendar_sync") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: sync
                      ? {
                          id: "personal",
                          google_calendar_id: sync.google_calendar_id,
                          calendar_summary: sync.calendar_summary,
                          updated_at: new Date().toISOString(),
                        }
                      : null,
                    error: null,
                  }),
                };
              },
            };
          },
          upsert(payload: Record<string, unknown>) {
            sync = {
              google_calendar_id: String(payload.google_calendar_id),
              calendar_summary: String(payload.calendar_summary ?? "placements"),
            };
            return {
              select() {
                return {
                  single: async () => ({
                    data: { id: "personal", ...sync, updated_at: new Date().toISOString() },
                    error: null,
                  }),
                };
              },
            };
          },
          delete() {
            return {
              eq: async () => {
                sync = null;
                return { error: null };
              },
            };
          },
        };
      }
      if (table === "calendar_event") {
        const filters: Record<string, string> = {};
        const builder = {
          select() {
            return builder;
          },
          eq(col: string, val: string) {
            filters[col] = val;
            return builder;
          },
          maybeSingle: async () => {
            const rows = filterEvents(filters);
            return { data: rows[0] ?? null, error: null };
          },
          then(resolve: (v: { data: EventRow[]; error: null }) => void) {
            resolve({ data: filterEvents(filters), error: null });
          },
          insert(payload: Record<string, unknown>) {
            const row: EventRow = {
              id: `ev-${events.length + 1}`,
              drive_id: String(payload.drive_id),
              round_key: String(payload.round_key),
              google_event_id: String(payload.google_event_id),
              source: String(payload.source),
              status: String(payload.status ?? "active"),
              start_at: (payload.start_at as string | null) ?? null,
              end_at: (payload.end_at as string | null) ?? null,
              title: String(payload.title ?? ""),
              created_at: String(payload.created_at ?? new Date().toISOString()),
              updated_at: String(payload.updated_at ?? new Date().toISOString()),
            };
            events.push(row);
            return {
              select() {
                return {
                  single: async () => ({ data: row, error: null }),
                };
              },
            };
          },
          update(payload: Record<string, unknown>) {
            return {
              eq(_col: string, id: string) {
                const row = events.find((e) => e.id === id);
                if (row) {
                  Object.assign(row, payload);
                }
                return {
                  select() {
                    return {
                      single: async () => ({ data: row, error: null }),
                    };
                  },
                };
              },
            };
          },
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe("syncCalendarEvent", () => {
  it("creates once, reschedule patches same id, cancel deletes, recreate after cancel", async () => {
    const events: EventRow[] = [];
    const db = calendarDbFixed(events);
    const calls: string[] = [];
    let eventCounter = 0;

    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "tok", expires_in: 3600 });
      }
      if (url.includes("/calendars/cal-placements") && method === "GET" && !url.includes("/events")) {
        return Response.json({ id: "cal-placements", summary: "placements" });
      }
      if (url.includes("/calendars/cal-placements/events") && method === "POST") {
        expect(url).not.toContain("primary");
        eventCounter += 1;
        const id = `gev-${eventCounter}`;
        calls.push(`create:${id}`);
        return Response.json({ id });
      }
      if (url.includes("/calendars/cal-placements/events/") && method === "PATCH") {
        const id = url.split("/events/")[1]!;
        calls.push(`patch:${id}`);
        return Response.json({ id });
      }
      if (url.includes("/calendars/cal-placements/events/") && method === "DELETE") {
        const id = url.split("/events/")[1]!;
        calls.push(`delete:${id}`);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const now = new Date("2026-10-11T06:00:00.000Z");
    const create = await syncCalendarEvent({
      config,
      db: db as never,
      drive: drive(),
      classification: "interview",
      subject: "Interview schedule",
      body: "Your technical interview is scheduled for Monday 10am.",
      fetch: fetchImpl as typeof fetch,
      now,
    });
    expect(create.ok).toBe(true);
    expect(create.reason).toBe("created");
    expect(create.googleEventId).toBe("gev-1");
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("active");

    const reschedule = await syncCalendarEvent({
      config,
      db: db as never,
      drive: drive(),
      classification: "reschedule",
      subject: "Interview rescheduled",
      body: "Your interview has been rescheduled to Friday 2pm.",
      fetch: fetchImpl as typeof fetch,
      now: new Date("2026-10-12T06:00:00.000Z"),
    });
    expect(reschedule.ok).toBe(true);
    expect(reschedule.googleEventId).toBe("gev-1");
    expect(calls).toContain("patch:gev-1");
    expect(events).toHaveLength(1);

    const cancel = await syncCalendarEvent({
      config,
      db: db as never,
      drive: drive(),
      classification: "cancel",
      subject: "Cancelled",
      body: "The interview is cancelled.",
      fetch: fetchImpl as typeof fetch,
      now,
    });
    expect(cancel.ok).toBe(true);
    expect(calls).toContain("delete:gev-1");
    expect(events[0]!.status).toBe("cancelled");

    const recreate = await syncCalendarEvent({
      config,
      db: db as never,
      drive: drive(),
      classification: "interview",
      subject: "Interview schedule",
      body: "Your technical interview is scheduled for Monday 10am.",
      fetch: fetchImpl as typeof fetch,
      now,
    });
    expect(recreate.ok).toBe(true);
    expect(recreate.googleEventId).toBe("gev-2");
    expect(events[0]!.google_event_id).toBe("gev-2");
    expect(events[0]!.status).toBe("active");
  });
});
