import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../app/config.ts";
import type { DriveRow } from "../../app/db/drive.ts";
import type { MailRow } from "../../app/db/mail.ts";
import { applyClassification } from "../../app/mail/applyClassification.ts";
import type { TelegramClient } from "../../app/telegram/client.ts";

const baseConfig = {
  HOST: "0.0.0.0",
  PORT: 10000,
  LOG_LEVEL: "silent",
  CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
} as Config;

function drive(overrides: Partial<DriveRow> = {}): DriveRow {
  return {
    id: "drive-1",
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

function mailRow(overrides: Partial<MailRow> = {}): MailRow {
  return {
    id: "mail-1",
    gmail_message_id: "msg-1",
    gmail_thread_id: "thr-1",
    account: "pesu",
    drive_id: "drive-1",
    classification: "assessment",
    confidence: "high",
    subject: "OA",
    snippet: "link",
    classified_at: "2026-01-01T00:00:00.000Z",
    notified_at: null,
    raw_meta: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function driveDb(row: DriveRow) {
  return {
    from(table: string) {
      if (table === "drive") {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: async () => ({ data: row, error: null }) };
              },
            };
          },
          update: (payload: Record<string, unknown>) => ({
            eq: async () => {
              Object.assign(row, payload);
              return { error: null };
            },
          }),
        };
      }
      if (table === "mail") {
        return {
          update: () => ({
            eq: async () => ({ error: null }),
          }),
        };
      }
      throw new Error(`unexpected ${table}`);
    },
  };
}

describe("applyClassification calendar hooks", () => {
  it("does not create calendar when no time and no personal token", async () => {
    const row = drive();
    const texts: string[] = [];
    const telegram = {
      sendMessage: async (_chatId: string, text: string) => {
        texts.push(text);
        return { ok: true as const };
      },
    } as unknown as TelegramClient;

    await applyClassification(
      {
        config: baseConfig,
        db: driveDb(row) as never,
        telegram,
        chatId: "1",
        bodyText: "Please complete the online assessment within 48 hours.",
      },
      mailRow(),
      { classification: "assessment", confidence: "high", reason: "assessment_keywords" },
      { drive: row, bodyText: "Please complete the online assessment within 48 hours." },
    );

    expect(texts[0]).toContain("Assessment:");
    expect(texts[0]).not.toMatch(/Calendar: \d/);
  });

  it("calls calendar create when personal token and mail time present", async () => {
    const row = drive();
    const config = {
      ...baseConfig,
      GOOGLE_CLIENT_ID: "cid",
      GOOGLE_CLIENT_SECRET: "sec",
      GOOGLE_REFRESH_TOKEN_PERSONAL: "ref",
    } as Config;

    const events: Array<Record<string, unknown>> = [];
    let sync: { google_calendar_id: string; calendar_summary: string } | null = {
      google_calendar_id: "cal-p",
      calendar_summary: "placements",
    };

    const db = {
      from(table: string) {
        if (table === "drive") {
          return {
            select() {
              return {
                eq() {
                  return { maybeSingle: async () => ({ data: row, error: null }) };
                },
              };
            },
            update: (payload: Record<string, unknown>) => ({
              eq: async () => {
                Object.assign(row, payload);
                return { error: null };
              },
            }),
          };
        }
        if (table === "mail") {
          return {
            update: () => ({
              eq: async () => ({ error: null }),
            }),
          };
        }
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
                            ...sync,
                            updated_at: new Date().toISOString(),
                          }
                        : null,
                      error: null,
                    }),
                  };
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
            maybeSingle: async () => ({ data: null, error: null }),
            then(resolve: (v: { data: unknown[]; error: null }) => void) {
              resolve({ data: [], error: null });
            },
            insert(payload: Record<string, unknown>) {
              const rowEv = {
                id: "ev1",
                ...payload,
                created_at: new Date().toISOString(),
              };
              events.push(rowEv);
              return {
                select() {
                  return { single: async () => ({ data: rowEv, error: null }) };
                },
              };
            },
            update() {
              return {
                eq() {
                  return {
                    select() {
                      return { single: async () => ({ data: events[0], error: null }) };
                    },
                  };
                },
              };
            },
          };
          return builder;
        }
        throw new Error(`unexpected ${table}`);
      },
    };

    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("oauth2")) {
        return Response.json({ access_token: "t", expires_in: 3600 });
      }
      if (url.includes("/calendars/cal-p") && method === "GET" && !url.includes("/events")) {
        return Response.json({ id: "cal-p", summary: "placements" });
      }
      if (url.includes("/events") && method === "POST") {
        expect(url).toContain("cal-p");
        expect(url).not.toContain("primary");
        return Response.json({ id: "gev-new" });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const texts: string[] = [];
    const telegram = {
      sendMessage: async (_chatId: string, text: string) => {
        texts.push(text);
        return { ok: true as const };
      },
    } as unknown as TelegramClient;

    await applyClassification(
      {
        config,
        db: db as never,
        telegram,
        chatId: "1",
        fetch: fetchImpl as typeof fetch,
        now: new Date("2026-10-11T06:00:00.000Z"),
        bodyText: "Your technical interview is scheduled for Monday 10am.",
      },
      mailRow({ classification: "interview", subject: "Interview" }),
      { classification: "interview", confidence: "high", reason: "interview_keywords" },
      {
        drive: row,
        bodyText: "Your technical interview is scheduled for Monday 10am.",
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.google_event_id).toBe("gev-new");
    expect(texts[0]).toMatch(/Calendar:/);
  });
});
