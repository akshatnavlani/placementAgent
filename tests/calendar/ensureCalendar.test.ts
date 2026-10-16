import { describe, expect, it, vi } from "vitest";
import { CalendarClient } from "../../app/calendar/client.ts";
import { ensurePlacementsCalendar } from "../../app/calendar/ensureCalendar.ts";

function memoryDb(state: {
  sync: { google_calendar_id: string; calendar_summary: string } | null;
}) {
  return {
    from(table: string) {
      if (table !== "calendar_sync") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: state.sync
                    ? {
                        id: "personal",
                        google_calendar_id: state.sync.google_calendar_id,
                        calendar_summary: state.sync.calendar_summary,
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
          state.sync = {
            google_calendar_id: String(payload.google_calendar_id),
            calendar_summary: String(payload.calendar_summary ?? "placements"),
          };
          return {
            select() {
              return {
                single: async () => ({
                  data: {
                    id: "personal",
                    ...state.sync,
                    updated_at: new Date().toISOString(),
                  },
                  error: null,
                }),
              };
            },
          };
        },
        delete() {
          return {
            eq: async () => {
              state.sync = null;
              return { error: null };
            },
          };
        },
      };
    },
  };
}

describe("ensurePlacementsCalendar", () => {
  it("creates placements when missing and never uses primary", async () => {
    const state = { sync: null as { google_calendar_id: string; calendar_summary: string } | null };
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "tok", expires_in: 3600 });
      }
      if (url.includes("/users/me/calendarList") && (!init?.method || init.method === "GET")) {
        return Response.json({
          items: [{ id: "primary", summary: "Personal" }],
        });
      }
      if (url.endsWith("/calendars") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.summary).toBe("placements");
        return Response.json({ id: "cal-placements-1", summary: "placements" });
      }
      throw new Error(`unexpected ${url} ${init?.method}`);
    });

    const client = new CalendarClient({
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
      fetch: fetchImpl as typeof fetch,
    });

    const result = await ensurePlacementsCalendar({
      db: memoryDb(state) as never,
      client,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.calendarId).toBe("cal-placements-1");
      expect(result.value.calendarId).not.toBe("primary");
    }
    expect(state.sync?.google_calendar_id).toBe("cal-placements-1");
  });

  it("reuses stored id when calendar still exists", async () => {
    const state = {
      sync: { google_calendar_id: "cal-existing", calendar_summary: "placements" },
    };
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "tok", expires_in: 3600 });
      }
      if (url.includes("/calendars/cal-existing")) {
        return Response.json({ id: "cal-existing", summary: "placements" });
      }
      throw new Error(`unexpected ${url}`);
    });

    const client = new CalendarClient({
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
      fetch: fetchImpl as typeof fetch,
    });

    const result = await ensurePlacementsCalendar({
      db: memoryDb(state) as never,
      client,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.calendarId).toBe("cal-existing");
    }
  });
});
