import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.ts";
import type { DriveRow } from "../app/db/drive.ts";
import { NotionClient } from "../app/notion/client.ts";
import { PlacementClient, type CatalogEvent } from "../app/placement/client.ts";
import { runPoll } from "../app/poll/runPoll.ts";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const listFixture = JSON.parse(readFileSync(path.join(fixturesDir, "list.json"), "utf8")) as {
  events: CatalogEvent[];
};
const detailFixture = JSON.parse(
  readFileSync(path.join(fixturesDir, "detail-fidelity.json"), "utf8"),
) as CatalogEvent;

const baseConfig = {
  HOST: "0.0.0.0",
  PORT: 10000,
  LOG_LEVEL: "silent",
  CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
  PLACEMENT_STUDENT_ID: "PES1UG00FAKE",
  PLACEMENT_PASSWORD: "not-used-in-poll",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
} as Config;

function memoryStore(seed: DriveRow[] = []) {
  const rows = new Map(seed.map((r) => [r.id, structuredClone(r)]));
  const ops: string[] = [];

  const db = {
    from(table: string) {
      if (table === "secret") {
        const secretRow: Record<string, unknown> = {
          id: 1,
          bearer_token: "stored-token",
          token_obtained_at: "2026-01-01T00:00:00.000Z",
          token_source: "validatestudent",
          login_wait_state: null,
          login_wait_notified_at: null,
          otp_sent_at: null,
          otp_paste_prompted_at: null,
        };
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: { ...secretRow },
                    error: null,
                  }),
                };
              },
            };
          },
          update: (payload: Record<string, unknown>) => ({
            eq: async () => {
              Object.assign(secretRow, payload);
              return { error: null };
            },
          }),
          upsert: async (payload: Record<string, unknown>) => {
            Object.assign(secretRow, payload);
            return { error: null };
          },
        };
      }
      if (table === "profile") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: {
                      id: 1,
                      student_id: "PES1UG00FAKE",
                      platform: {
                        batch: 2027,
                        department: "CSE",
                        graduateDegree: "BTech",
                        currentCGPA: 8,
                        tenthPercentage: 90,
                        twelfthPercentage: 90,
                        activeBacklogs: 0,
                      },
                      // Fresh so daily getStudent refresh is skipped in unit tests.
                      platform_synced_at: "2099-01-01T00:00:00.000Z",
                    },
                    error: null,
                  }),
                };
              },
            };
          },
          update: async () => ({ error: null }),
          upsert: async () => ({ error: null }),
        };
      }
      if (table === "drive") {
        return {
          select() {
            const api = {
              eq(_col: string, id: string) {
                return {
                  maybeSingle: async () => ({ data: rows.get(id) ?? null, error: null }),
                };
              },
              then(resolve: (value: { data: DriveRow[]; error: null }) => unknown) {
                return Promise.resolve(resolve({ data: [...rows.values()], error: null }));
              },
            };
            return api;
          },
          insert: async (payload: Record<string, unknown>) => {
            ops.push(`insert:${payload.id}`);
            rows.set(String(payload.id), payload as unknown as DriveRow);
            return { error: null };
          },
          update: (payload: Record<string, unknown>) => {
            const api = {
              eq(_col: string, id: string) {
                ops.push(`update:${id}`);
                const prev = rows.get(id);
                if (prev) {
                  rows.set(id, { ...prev, ...payload } as DriveRow);
                }
                return {
                  eq: async () => ({ error: null }),
                  then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })),
                };
              },
              in(_col: string, ids: string[]) {
                ops.push(`in:${ids.join(",")}`);
                for (const id of ids) {
                  const prev = rows.get(id);
                  if (prev) {
                    rows.set(id, { ...prev, ...payload } as DriveRow);
                  }
                }
                return {
                  eq: async () => ({ error: null }),
                  then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })),
                };
              },
            };
            return api;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { db: db as never, rows, ops };
}

describe("runPoll", () => {
  it("keeps prior rows when the list call fails", async () => {
    const seed: DriveRow[] = [
      {
        id: "existing-1",
        raw_list: { _id: "existing-1" },
        raw_detail: null,
        updated_at_platform: "2026-01-01T00:00:00.000Z",
        is_eligible: true,
        deadline: "2099-01-01T00:00:00.000Z",
        status: "New",
        reminder_sent: false,
    reminder_tiers_sent: [],
        draft_status: null,
        notion_page_id: null,
        pdf_urls: [],
        pdf_text: {},
        company_id: null,
        company_name: "Existing",
        company_username: null,
        event_name: null,
        first_seen_at: "2026-01-01T00:00:00.000Z",
        last_seen_at: "2026-01-01T00:00:00.000Z",
        alerted_at: "2026-01-01T00:00:00.000Z",
        applied_at: null,
        last_apply_check_at: null,
      },
    ];
    const { db, rows, ops } = memoryStore(seed);
    const placement = new PlacementClient({
      fetch: vi.fn(async () => new Response(JSON.stringify({ message: "no" }), { status: 500 })) as unknown as typeof fetch,
    });

    const result = await runPoll({
      config: baseConfig,
      db,
      placement,
      notify: false,
      reminders: false,
      dailyApply: false,
      listExisting: async () => [...rows.values()],
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(result.ok).toBe(false);
    expect(result.alert).toBe("http");
    expect(rows.get("existing-1")?.company_name).toBe("Existing");
    expect(ops.filter((o) => o.startsWith("insert:") || o.startsWith("update:"))).toEqual([]);
  });

  it("treats success:false as failure and does not wipe", async () => {
    const { db, rows } = memoryStore([
      {
        id: "keep-me",
        raw_list: {},
        raw_detail: null,
        updated_at_platform: null,
        is_eligible: true,
        deadline: null,
        status: "New",
        reminder_sent: false,
    reminder_tiers_sent: [],
        draft_status: null,
        notion_page_id: null,
        pdf_urls: [],
        pdf_text: {},
        company_id: null,
        company_name: "Keep",
        company_username: null,
        event_name: null,
        first_seen_at: "2026-01-01T00:00:00.000Z",
        last_seen_at: "2026-01-01T00:00:00.000Z",
        alerted_at: "2026-01-01T00:00:00.000Z",
        applied_at: null,
        last_apply_check_at: null,
      },
    ]);
    const placement = new PlacementClient({
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ success: false, events: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof fetch,
    });

    const result = await runPoll({
      config: baseConfig,
      db,
      placement,
      notify: false,
      reminders: false,
      dailyApply: false,
      listExisting: async () => [...rows.values()],
    });
    expect(result.ok).toBe(false);
    expect(result.alert).toBe("invalid");
    expect(rows.has("keep-me")).toBe(true);
  });

  it("does not re-download PDFs on an unchanged second poll", async () => {
    const event = structuredClone(listFixture.events[1]!) as CatalogEvent;
    event.pdfUrls = ["https://example.com/jd.pdf"];
    event.deadline = "2099-01-01T00:00:00.000Z";
    event.isEligible = true;

    const detail = structuredClone(detailFixture);
    detail._id = event._id;
    detail.pdfUrls = ["https://example.com/jd.pdf"];

    let listCalls = 0;
    let pdfCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("getEventsByStudentEligibility")) {
        listCalls += 1;
        return new Response(JSON.stringify({ success: true, events: [event] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("getEventDetails")) {
        return new Response(JSON.stringify(detail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("example.com/jd.pdf")) {
        pdfCalls += 1;
        return new Response(Uint8Array.from([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      return new Response("no", { status: 404 });
    });

    // Stub extract by pre-seeding pdf_text after first poll via inject — instead mock extract path:
    // First poll will fail extract on tiny bytes; to avoid depending on pdf-parse for this test,
    // seed an existing row with pdf_text already filled and same updatedAt so second path is touch-only.
    const seeded: DriveRow = {
      id: event._id,
      raw_list: event as Record<string, unknown>,
      raw_detail: detail as Record<string, unknown>,
      updated_at_platform: String(event.updatedAt),
      is_eligible: true,
      deadline: String(event.deadline),
      status: "New",
      reminder_sent: false,
    reminder_tiers_sent: [],
      draft_status: null,
      notion_page_id: null,
      pdf_urls: ["https://example.com/jd.pdf"],
      pdf_text: { "https://example.com/jd.pdf": "already extracted" },
      company_id: null,
      company_name: String(event.companyName ?? ""),
      company_username: null,
      event_name: null,
      first_seen_at: "2026-01-01T00:00:00.000Z",
      last_seen_at: "2026-01-01T00:00:00.000Z",
      alerted_at: "2026-01-01T00:00:00.000Z",
      applied_at: null,
      last_apply_check_at: null,
    };

    const { db, rows } = memoryStore([seeded]);
    const placement = new PlacementClient({ fetch: fetchMock as unknown as typeof fetch });

    const first = await runPoll({
      config: baseConfig,
      db,
      placement,
      notify: false,
      reminders: false,
      dailyApply: false,
      fetch: fetchMock as unknown as typeof fetch,
      listExisting: async () => [...rows.values()],
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(first.ok).toBe(true);
    expect(first.touched).toBe(1);
    expect(pdfCalls).toBe(0);

    const second = await runPoll({
      config: baseConfig,
      db,
      placement,
      notify: false,
      reminders: false,
      dailyApply: false,
      fetch: fetchMock as unknown as typeof fetch,
      listExisting: async () => [...rows.values()],
      now: new Date("2026-01-02T00:05:00.000Z"),
    });
    expect(second.ok).toBe(true);
    expect(second.touched).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.refreshed).toBe(0);
    expect(pdfCalls).toBe(0);
    expect(listCalls).toBe(2);
  });

  it("creates a drive row for a new _id", async () => {
    const event = structuredClone(listFixture.events[0]!) as CatalogEvent;
    event.deadline = "2099-01-01T00:00:00.000Z";
    event.pdfUrls = [];

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("getEventsByStudentEligibility")) {
        return new Response(JSON.stringify({ success: true, events: [event] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("getEventDetails")) {
        return new Response(JSON.stringify({ ...event, formattedEventDate: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });

    const { db, rows } = memoryStore([]);
    const placement = new PlacementClient({ fetch: fetchMock as unknown as typeof fetch });
    const result = await runPoll({
      config: baseConfig,
      db,
      placement,
      notify: false,
      reminders: false,
      dailyApply: false,
      fetch: fetchMock as unknown as typeof fetch,
      listExisting: async () => [...rows.values()],
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(1);
    expect(rows.has(event._id)).toBe(true);
    expect(rows.get(event._id)?.status).toBe("New");
    expect(result.alerts).toContain("notion_skipped");
    expect(result.notionSynced).toBe(0);
  });

  it("syncs Notion on eligible insert and skips on touch", async () => {
    const event = structuredClone(listFixture.events[0]!) as CatalogEvent;
    event.deadline = "2099-01-01T00:00:00.000Z";
    event.pdfUrls = [];

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("getEventsByStudentEligibility")) {
        return new Response(JSON.stringify({ success: true, events: [event] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("getEventDetails")) {
        return new Response(JSON.stringify({ ...event, formattedEventDate: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });

    const notionFetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: "notion-page-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const notion = new NotionClient({
      token: "notion-test-token",
      fetch: notionFetch as unknown as typeof fetch,
    });

    const config = {
      ...baseConfig,
      NOTION_TOKEN: "notion-test-token",
      NOTION_DATABASE_ID: "11b47a447b504720ac1b32d6ceaee46c",
    } as Config;

    const { db, rows } = memoryStore([]);
    const placement = new PlacementClient({ fetch: fetchMock as unknown as typeof fetch });
    const first = await runPoll({
      config,
      db,
      placement,
      notify: false,
      reminders: false,
      dailyApply: false,
      fetch: fetchMock as unknown as typeof fetch,
      listExisting: async () => [...rows.values()],
      now: new Date("2026-01-02T00:00:00.000Z"),
      notion,
    });

    expect(first.ok).toBe(true);
    expect(first.inserted).toBe(1);
    expect(first.notionSynced).toBe(1);
    expect(rows.get(event._id)?.notion_page_id).toBe("notion-page-1");
    expect(notionFetch).toHaveBeenCalled();

    const notionCallsAfterInsert = notionFetch.mock.calls.length;
    const second = await runPoll({
      config,
      db,
      placement,
      notify: false,
      reminders: false,
      dailyApply: false,
      fetch: fetchMock as unknown as typeof fetch,
      listExisting: async () => [...rows.values()],
      now: new Date("2026-01-02T00:05:00.000Z"),
      notion,
    });
    expect(second.ok).toBe(true);
    expect(second.touched).toBe(1);
    expect(second.notionSynced).toBe(0);
    expect(notionFetch.mock.calls.length).toBe(notionCallsAfterInsert);
  });
});
