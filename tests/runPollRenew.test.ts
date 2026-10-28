import { describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.ts";
import type { DriveRow } from "../app/db/drive.ts";
import { PlacementClient } from "../app/placement/client.ts";
import { runPoll } from "../app/poll/runPoll.ts";

const baseConfig = {
  HOST: "0.0.0.0",
  PORT: 10000,
  LOG_LEVEL: "silent",
  CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
  PLACEMENT_STUDENT_ID: "PES1UG00FAKE",
  PLACEMENT_PASSWORD: "secret-pass",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
} as Config;

function memoryDb(seed: DriveRow[] = [], secretSeed: Record<string, unknown> = {}) {
  const rows = new Map(seed.map((r) => [r.id, structuredClone(r)]));
  const secretRow: Record<string, unknown> = {
    id: 1,
    bearer_token: "bad-token",
    token_obtained_at: "2026-01-01T00:00:00.000Z",
    token_source: "validatestudent",
    login_wait_state: null,
    login_wait_notified_at: null,
    otp_sent_at: null,
    otp_paste_prompted_at: null,
    ...secretSeed,
  };
  const profileRow = {
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
    platform_synced_at: "2099-01-01T00:00:00.000Z",
  };

  const db = {
    from(table: string) {
      if (table === "secret") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { ...secretRow }, error: null }),
            }),
          }),
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
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { ...profileRow }, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: async () => {
              Object.assign(profileRow, payload);
              return { error: null };
            },
          }),
        };
      }
      if (table === "drive") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => ({ data: rows.get(id) ?? null, error: null }),
            }),
            then: (resolve: (v: { data: DriveRow[]; error: null }) => unknown) =>
              Promise.resolve(resolve({ data: [...rows.values()], error: null })),
          }),
          insert: async (payload: Record<string, unknown>) => {
            rows.set(String(payload.id), payload as unknown as DriveRow);
            return { error: null };
          },
          update: (payload: Record<string, unknown>) => ({
            eq: (_c: string, id: string) => {
              const prev = rows.get(id);
              if (prev) {
                rows.set(id, { ...prev, ...payload } as DriveRow);
              }
              return {
                eq: async () => ({ error: null }),
                then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })),
              };
            },
            in: (_c: string, ids: string[]) => {
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
          }),
        };
      }
      throw new Error(`unexpected ${table}`);
    },
  };
  return { db: db as never, rows, secretRow };
}

describe("runPoll renewal", () => {
  it("retries once after password renew on list 401", async () => {
    const { db, secretRow } = memoryDb();
    let listCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("getEventsByStudentEligibility")) {
        listCalls += 1;
        if (listCalls === 1) {
          return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
        }
        return new Response(JSON.stringify({ success: true, events: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("validatestudent")) {
        return new Response(
          JSON.stringify({
            success: true,
            token: "fresh-token",
            studentData: { studentID: "PES1UG00FAKE", batch: 2027 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("no", { status: 404 });
    });

    const placement = new PlacementClient({
      fetch: fetchMock as unknown as typeof fetch,
      onUnauthorized: async () => {
        secretRow.bearer_token = null;
      },
    });

    const result = await runPoll({
      config: baseConfig,
      db,
      placement,
      notify: false,
      reminders: false,
      dailyApply: false,
      reconcileApplied: false,
      notionSync: false,
      listExisting: async () => [],
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(listCalls).toBe(2);
    expect(secretRow.bearer_token).toBe("fresh-token");
  });

  it("waits without wiping drives when renew needs approval", async () => {
    const seed: DriveRow[] = [
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
    last_rejection_ask_at: null,
      },
    ];
    const { db, rows } = memoryDb(seed);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("getEventsByStudentEligibility")) {
        return new Response("{}", { status: 401 });
      }
      if (url.includes("validatestudent")) {
        return new Response(JSON.stringify({ success: true, studentData: { studentID: "PES1UG00FAKE" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });
    const placement = new PlacementClient({ fetch: fetchMock as unknown as typeof fetch });

    const result = await runPoll({
      config: baseConfig,
      db,
      placement,
      notify: false,
      reminders: false,
      dailyApply: false,
      reconcileApplied: false,
      notionSync: false,
      listExisting: async () => [...rows.values()],
    });

    expect(result.ok).toBe(false);
    expect(result.alert).toBe("awaiting_login_approval");
    expect(rows.has("keep-me")).toBe(true);
  });
});
