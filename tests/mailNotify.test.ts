import { describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.ts";
import type { DriveRow } from "../app/db/drive.ts";
import type { MailRow } from "../app/db/mail.ts";
import { applyClassification } from "../app/mail/applyClassification.ts";
import type { TelegramClient } from "../app/telegram/client.ts";

const config = {
  HOST: "0.0.0.0",
  PORT: 10000,
  LOG_LEVEL: "silent",
  CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
} as Config;

function drive(): DriveRow {
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
  };
}

function mailRow(overrides: Partial<MailRow> = {}): MailRow {
  return {
    id: "mail-1",
    gmail_message_id: "msg-1",
    gmail_thread_id: "thr-1",
    account: "pesu",
    drive_id: "drive-1",
    classification: "interview",
    confidence: "high",
    subject: "Interview",
    snippet: "scheduled",
    classified_at: "2026-01-01T00:00:00.000Z",
    notified_at: null,
    raw_meta: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyClassification notify idempotency", () => {
  it("does not double-notify when notified_at is set", async () => {
    const row = drive();
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
        throw new Error(table);
      },
    } as never;

    const sendMessage = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const telegram = { sendMessage } as unknown as TelegramClient;

    const first = await applyClassification(
      { config, db, telegram, chatId: "1" },
      mailRow(),
      { classification: "interview", confidence: "high", reason: "interview_keywords" },
      { drive: row },
    );
    expect(first.notified).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const text = String(sendMessage.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("Subject: Interview");
    expect(text).toContain("Acme");

    const second = await applyClassification(
      { config, db, telegram, chatId: "1" },
      mailRow({ notified_at: "2026-01-01T01:00:00.000Z" }),
      { classification: "interview", confidence: "high", reason: "interview_keywords" },
      { drive: row },
    );
    expect(second.notified).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("notifies high-signal reschedule even without a drive match", async () => {
    const db = {
      from(table: string) {
        if (table === "mail") {
          return {
            update: () => ({
              eq: async () => ({ error: null }),
            }),
          };
        }
        throw new Error(table);
      },
    } as never;

    const sendMessage = vi.fn(async () => ({ ok: true as const, messageId: 2 }));
    const telegram = { sendMessage } as unknown as TelegramClient;

    const result = await applyClassification(
      { config, db, telegram, chatId: "1" },
      mailRow({
        drive_id: null,
        classification: "reschedule",
        subject: "Re: Zensar location preference required",
      }),
      { classification: "reschedule", confidence: "high", reason: "reschedule_keywords" },
      {},
    );
    expect(result.notified).toBe(true);
    expect(result.reason).toBe("no_drive_match_notified");
    const text = String(sendMessage.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("Reschedule noted");
    expect(text).toContain("Zensar");
  });
});
