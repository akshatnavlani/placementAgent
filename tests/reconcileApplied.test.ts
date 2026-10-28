import { describe, expect, it, vi } from "vitest";
import {
  needsRejectionAsk,
  reconcileAppliedEvents,
  reconcileInternals,
} from "../app/apply/reconcileApplied.ts";
import type { Config } from "../app/config.ts";
import type { DriveRow } from "../app/db/drive.ts";
import { PlacementClient } from "../app/placement/client.ts";
import { TelegramClient } from "../app/telegram/client.ts";
import { decodeCallback } from "../app/telegram/buttons.ts";

const baseConfig = {
  HOST: "0.0.0.0",
  PORT: 10000,
  LOG_LEVEL: "silent",
  CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
  PLACEMENT_STUDENT_ID: "PES1UG00FAKE",
  PLACEMENT_PASSWORD: "secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb",
} as Config;

function drive(partial: Partial<DriveRow> & { id: string }): DriveRow {
  return {
    raw_list: {},
    raw_detail: null,
    updated_at_platform: null,
    is_eligible: true,
    deadline: null,
    status: "Applied",
    reminder_sent: false,
    reminder_tiers_sent: [],
    draft_status: null,
    notion_page_id: null,
    pdf_urls: [],
    pdf_text: {},
    company_id: null,
    company_name: "Acme",
    company_username: "acme",
    event_name: "SDE",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    alerted_at: null,
    applied_at: "2026-01-01T00:00:00.000Z",
    last_apply_check_at: null,
    last_rejection_ask_at: null,
    ...partial,
  };
}

describe("needsRejectionAsk", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");

  it("asks when never asked", () => {
    expect(needsRejectionAsk(drive({ id: "a" }), now)).toBe(true);
  });

  it("skips within cooldown", () => {
    expect(
      needsRejectionAsk(
        drive({ id: "a", last_rejection_ask_at: "2026-01-31T12:00:00.000Z" }),
        now,
      ),
    ).toBe(false);
  });

  it("asks after cooldown", () => {
    const old = new Date(now.getTime() - reconcileInternals.ASK_COOLDOWN_MS - 1000).toISOString();
    expect(needsRejectionAsk(drive({ id: "a", last_rejection_ask_at: old }), now)).toBe(true);
  });
});

describe("decode reject_confirm", () => {
  it("parses yes/no", () => {
    expect(decodeCallback("rj:y:abc123")).toEqual({
      kind: "reject_confirm",
      driveId: "abc123",
      rejected: true,
    });
    expect(decodeCallback("rj:n:abc123")).toEqual({
      kind: "reject_confirm",
      driveId: "abc123",
      rejected: false,
    });
  });
});

describe("reconcileAppliedEvents", () => {
  it("asks for drives missing from getAppliedEvents", async () => {
    const messages: string[] = [];
    const stamped: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("getAppliedEvents")) {
        return new Response(
          JSON.stringify({
            appliedEvents: [{ eventID: "still-here", companyName: "Keep" }],
          }),
          { status: 200 },
        );
      }
      if (String(url).includes("sendMessage")) {
        const body = JSON.parse(String(init?.body)) as { text: string };
        messages.push(body.text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    });

    const db = {
      from(table: string) {
        if (table === "secret") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { bearer_token: "tok", id: 1 },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "drive") {
          return {
            update: (payload: Record<string, unknown>) => ({
              eq: (col: string, id: string) => {
                if (col === "id" && payload.last_rejection_ask_at) {
                  stamped.push(id);
                }
                return Promise.resolve({ error: null });
              },
            }),
          };
        }
        throw new Error(table);
      },
    };

    const summary = await reconcileAppliedEvents({
      config: baseConfig,
      db: db as never,
      placement: new PlacementClient({ fetch: fetchMock as unknown as typeof fetch }),
      telegram: new TelegramClient({
        botToken: "bot",
        fetch: fetchMock as unknown as typeof fetch,
      }),
      chatId: "1",
      now: new Date("2026-02-01T00:00:00.000Z"),
      listActive: async () => [
        drive({ id: "still-here", company_name: "Keep" }),
        drive({ id: "gone", company_name: "GoneCo" }),
      ],
    });

    expect(summary.checked).toBe(2);
    expect(summary.asked).toBe(1);
    expect(messages.some((m) => m.includes("GoneCo"))).toBe(true);
    expect(stamped).toContain("gone");
  });
});
