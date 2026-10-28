import { describe, expect, it, vi } from "vitest";
import { verifyApplied, verifyReplyText } from "../app/apply/verify.ts";
import type { Config } from "../app/config.ts";
import type { DriveRow } from "../app/db/drive.ts";
import { PlacementClient } from "../app/placement/client.ts";

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

function driveRow(partial: Partial<DriveRow> & { id: string }): DriveRow {
  return {
    raw_list: {},
    raw_detail: null,
    updated_at_platform: null,
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
    company_name: "Acme",
    company_username: null,
    event_name: "SDE",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    alerted_at: "2026-01-01T00:00:00.000Z",
    applied_at: null,
    last_apply_check_at: null,
    last_rejection_ask_at: null,
    ...partial,
  };
}

function applyStore(seed: DriveRow[], bearerToken: string | null = "tok") {
  const rows = new Map(seed.map((r) => [r.id, structuredClone(r)]));
  const secretRow: Record<string, unknown> = {
    id: 1,
    bearer_token: bearerToken,
    token_obtained_at: "2026-01-01T00:00:00.000Z",
    token_source: "validatestudent",
    login_wait_state: null,
    login_wait_notified_at: null,
    otp_sent_at: null,
    otp_paste_prompted_at: null,
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
        };
      }
      if (table === "drive") {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({ data: rows.get(id) ?? null, error: null }),
            }),
            then: (resolve: (v: { data: DriveRow[]; error: null }) => unknown) =>
              Promise.resolve(resolve({ data: [...rows.values()], error: null })),
          }),
          update: (payload: Record<string, unknown>) => {
            const filters: Array<[string, string]> = [];
            const api = {
              eq(col: string, val: string) {
                filters.push([col, val]);
                return api;
              },
              select(_cols: string) {
                return {
                  then: (resolve: (v: { data: Array<{ id: string }>; error: null }) => unknown) => {
                    const idFilter = filters.find((f) => f[0] === "id");
                    const statusFilter = filters.find((f) => f[0] === "status");
                    if (!idFilter) {
                      return Promise.resolve(resolve({ data: [], error: null }));
                    }
                    const prev = rows.get(idFilter[1]);
                    if (!prev) {
                      return Promise.resolve(resolve({ data: [], error: null }));
                    }
                    if (statusFilter && prev.status !== statusFilter[1]) {
                      return Promise.resolve(resolve({ data: [], error: null }));
                    }
                    rows.set(idFilter[1], { ...prev, ...payload } as DriveRow);
                    return Promise.resolve(resolve({ data: [{ id: idFilter[1] }], error: null }));
                  },
                };
              },
              then: (resolve: (v: { error: null }) => unknown) => {
                const idFilter = filters.find((f) => f[0] === "id");
                if (idFilter) {
                  const prev = rows.get(idFilter[1]);
                  if (prev) {
                    const statusFilter = filters.find((f) => f[0] === "status");
                    if (!statusFilter || prev.status === statusFilter[1]) {
                      rows.set(idFilter[1], { ...prev, ...payload } as DriveRow);
                    }
                  }
                }
                return Promise.resolve(resolve({ error: null }));
              },
            };
            return api;
          },
        };
      }
      throw new Error(`unexpected ${table}`);
    },
  };

  return { db: db as never, rows };
}

describe("verifyApplied", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");

  it("marks Applied + applied_at when platform says applied", async () => {
    const { db, rows } = applyStore([driveRow({ id: "d1" })]);
    const placement = new PlacementClient({
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ applied: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof fetch,
    });

    const result = await verifyApplied({ config: baseConfig, db, placement, now }, "d1");
    expect(result).toEqual({ kind: "applied", company: "Acme" });
    expect(rows.get("d1")?.status).toBe("Applied");
    expect(rows.get("d1")?.applied_at).toBe(now.toISOString());
    expect(rows.get("d1")?.last_apply_check_at).toBe(now.toISOString());
    expect(verifyReplyText(result)).toBe("Marked Applied: Acme.");
  });

  it("stays New when platform says not applied", async () => {
    const { db, rows } = applyStore([driveRow({ id: "d1" })]);
    const placement = new PlacementClient({
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ applied: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof fetch,
    });

    const result = await verifyApplied({ config: baseConfig, db, placement, now }, "d1");
    expect(result.kind).toBe("not_applied");
    expect(rows.get("d1")?.status).toBe("New");
    expect(rows.get("d1")?.applied_at).toBeNull();
    expect(rows.get("d1")?.last_apply_check_at).toBe(now.toISOString());
    expect(verifyReplyText(result)).toBe("Platform shows no application.");
  });

  it("stays New on network failure without tight retry", async () => {
    const { db, rows } = applyStore([driveRow({ id: "d1" })]);
    const placement = new PlacementClient({
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });

    const result = await verifyApplied({ config: baseConfig, db, placement, now }, "d1");
    expect(result.kind).toBe("could_not_verify");
    expect(rows.get("d1")?.status).toBe("New");
    expect(rows.get("d1")?.last_apply_check_at).toBeNull();
    expect(verifyReplyText(result)).toBe("Could not verify. Try Apply again later.");
  });

  it("refuses without a bearer token", async () => {
    const { db, rows } = applyStore([driveRow({ id: "d1" })], null);
    const placement = new PlacementClient({
      fetch: vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch,
    });

    const result = await verifyApplied({ config: baseConfig, db, placement, now }, "d1");
    expect(result.kind).toBe("no_token");
    expect(rows.get("d1")?.status).toBe("New");
  });
});
