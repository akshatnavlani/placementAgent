import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  importAppliedEvents,
  importAppliedReplyText,
} from "../app/apply/importApplied.ts";
import type { Config } from "../app/config.ts";
import type { DriveRow } from "../app/db/drive.ts";
import {
  appliedSelectionWantsAccepted,
  parseAppliedEventsPayload,
  type PlacementClient,
} from "../app/placement/client.ts";

const fixture = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/appliedEvents.json"),
    "utf8",
  ),
) as unknown;

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
    is_eligible: null,
    deadline: null,
    status: "New",
    reminder_sent: false,
    reminder_tiers_sent: [],
    draft_status: null,
    notion_page_id: null,
    pdf_urls: [],
    pdf_text: {},
    company_id: null,
    company_name: null,
    company_username: null,
    event_name: null,
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    alerted_at: null,
    applied_at: null,
    last_apply_check_at: null,
    last_rejection_ask_at: null,
    ...partial,
  };
}

describe("parseAppliedEventsPayload", () => {
  it("parses appliedEvents wrapper", () => {
    const items = parseAppliedEventsPayload(fixture);
    expect(items).toHaveLength(2);
    expect(items![0]!.eventId).toBe("evt-applied-1");
    expect(items![1]!.selectionStatus).toBe("placed");
  });

  it("parses bare array", () => {
    const items = parseAppliedEventsPayload([{ _id: "x1", selectionStatus: "selected" }]);
    expect(items).toEqual([
      expect.objectContaining({ eventId: "x1", selectionStatus: "selected" }),
    ]);
  });
});

describe("appliedSelectionWantsAccepted", () => {
  it("maps placed/selected", () => {
    expect(appliedSelectionWantsAccepted("placed")).toBe(true);
    expect(appliedSelectionWantsAccepted("selected")).toBe(true);
    expect(appliedSelectionWantsAccepted("applied")).toBe(false);
  });
});

describe("importAppliedEvents", () => {
  it("inserts missing Applied drives and upgrades placed to Accepted", async () => {
    const rows = new Map<string, DriveRow>();
    const db = {
      from: (table: string) => {
        if (table !== "drive" && table !== "secret") {
          throw new Error(`unexpected table ${table}`);
        }
        if (table === "secret") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { bearer_token: "tok", token_obtained_at: null, token_source: null },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => ({
                data: rows.get(id) ?? null,
                error: null,
              }),
            }),
          }),
          insert: async (payload: Record<string, unknown>) => {
            const id = String(payload.id);
            rows.set(
              id,
              driveRow({
                id,
                status: (payload.status as DriveRow["status"]) ?? null,
                company_name: (payload.company_name as string) ?? null,
                event_name: (payload.event_name as string) ?? null,
                raw_list: (payload.raw_list as Record<string, unknown>) ?? {},
              }),
            );
            return { error: null };
          },
          update: (payload: Record<string, unknown>) => ({
            eq: (_c: string, id: string) => ({
              select: async () => {
                const row = rows.get(id);
                if (!row) {
                  return { data: [], error: null };
                }
                rows.set(id, { ...row, ...payload, id } as DriveRow);
                return { data: [{ id }], error: null };
              },
              then: undefined,
            }),
          }),
        };
      },
    };

    // Patch update().eq() without select for stamp/setDetail paths
    const driveFrom = db.from.bind(db);
    (db as { from: typeof driveFrom }).from = ((table: string) => {
      const base = driveFrom(table) as Record<string, unknown>;
      if (table !== "drive") {
        return base;
      }
      return {
        ...base,
        update: (payload: Record<string, unknown>) => ({
          eq: (_c: string, id: string) => {
            const row = rows.get(id);
            if (row) {
              rows.set(id, { ...row, ...payload, id } as DriveRow);
            }
            return {
              select: async () => ({ data: row ? [{ id }] : [], error: null }),
            };
          },
        }),
      };
    }) as typeof driveFrom;

    const placement = {
      getAppliedEvents: vi.fn(async () => ({
        kind: "ok" as const,
        data: parseAppliedEventsPayload(fixture)!,
      })),
      getEventDetails: vi.fn(async (_t: string, id: string) => ({
        kind: "ok" as const,
        data: {
          _id: id,
          companyName: id === "evt-applied-1" ? "Acme Corp" : "Beta Ltd",
          eventName: "Role",
          companyUsername: "u",
          isEligible: true,
        },
      })),
    } as unknown as PlacementClient;

    const summary = await importAppliedEvents({
      config: baseConfig,
      db: db as never,
      placement,
      syncMail: false,
    });

    expect(summary.fetched).toBe(2);
    expect(summary.imported).toBe(2);
    expect(rows.get("evt-applied-1")?.status).toBe("Applied");
    expect(rows.get("evt-placed-1")?.status).toBe("Accepted");
    expect(summary.accepted).toBe(1);
  });

  it("does not clobber Interview", async () => {
    const rows = new Map<string, DriveRow>([
      ["evt-applied-1", driveRow({ id: "evt-applied-1", status: "Interview", company_name: "Acme" })],
    ]);
    const db = {
      from: (table: string) => {
        if (table === "secret") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { bearer_token: "tok" },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => ({ data: rows.get(id) ?? null, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: (_c: string, id: string) => {
              const row = rows.get(id);
              if (row && payload.status) {
                // setMailStage / markAppliedFromImport may update
                const from = row.status;
                if (from === "Interview" && payload.status === "Accepted") {
                  rows.set(id, { ...row, status: "Accepted" });
                } else if (payload.last_apply_check_at && !payload.status) {
                  rows.set(id, { ...row, last_apply_check_at: String(payload.last_apply_check_at) });
                }
              } else if (row) {
                rows.set(id, { ...row, ...payload, id } as DriveRow);
              }
              return { select: async () => ({ data: [{ id }], error: null }) };
            },
          }),
          insert: async () => ({ error: null }),
        };
      },
    };

    const placement = {
      getAppliedEvents: vi.fn(async () => ({
        kind: "ok" as const,
        data: parseAppliedEventsPayload({
          appliedEvents: [{ eventID: "evt-applied-1", selectionStatus: "applied" }],
        })!,
      })),
      getEventDetails: vi.fn(async () => ({ kind: "ok" as const, data: { _id: "evt-applied-1" } })),
    } as unknown as PlacementClient;

    const summary = await importAppliedEvents({
      config: baseConfig,
      db: db as never,
      placement,
      syncMail: false,
    });

    expect(summary.alreadyTracked).toBe(1);
    expect(summary.imported).toBe(0);
    expect(rows.get("evt-applied-1")?.status).toBe("Interview");
  });
});

describe("importAppliedReplyText", () => {
  it("formats summary", () => {
    expect(
      importAppliedReplyText({
        ok: true,
        fetched: 2,
        imported: 1,
        alreadyTracked: 1,
        accepted: 0,
        notionSynced: 1,
        mailProcessed: 3,
        alerts: [],
      }),
    ).toContain("Fetched: 2");
  });
});
