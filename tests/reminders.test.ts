import { describe, expect, it, vi } from "vitest";
import type { DriveRow } from "../app/db/drive.ts";
import { sendDeadlineReminders } from "../app/poll/reminders.ts";
import { nextReminderTierToSend } from "../app/poll/reminderTiers.ts";
import { TelegramClient } from "../app/telegram/client.ts";

function driveRow(partial: Partial<DriveRow> & { id: string }): DriveRow {
  return {
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
    company_name: "Acme",
    company_username: null,
    event_name: "SDE",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    alerted_at: "2026-01-01T00:00:00.000Z",
    applied_at: null,
    last_apply_check_at: null,
    ...partial,
  };
}

function alertStore(seed: DriveRow[]) {
  const rows = new Map(seed.map((r) => [r.id, structuredClone(r)]));
  const db = {
    from(table: string) {
      if (table !== "drive") {
        throw new Error(`unexpected ${table}`);
      }
      return {
        select: () => ({
          eq: (_col: string, id: string) => ({
            maybeSingle: async () => ({ data: rows.get(id) ?? null, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            const prev = rows.get(id);
            if (prev) {
              rows.set(id, { ...prev, ...payload } as DriveRow);
            }
            return { error: null };
          },
        }),
      };
    },
  };
  return { db: db as never, rows };
}

describe("nextReminderTierToSend", () => {
  const now = new Date("2026-10-16T00:00:00.000Z");

  it("returns due tiers not yet sent", () => {
    const deadline = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    expect(nextReminderTierToSend(deadline, [], now)).toEqual(["12h", "6h", "3h"]);
    expect(nextReminderTierToSend(deadline, ["12h", "6h", "3h"], now)).toEqual([]);
  });
});

describe("sendDeadlineReminders", () => {
  const now = new Date("2026-10-16T00:00:00.000Z");

  it("sends one reminder for New under 6h and records tiers", async () => {
    const deadline = new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString();
    const { db, rows } = alertStore([driveRow({ id: "soon", deadline })]);
    let messages = 0;
    const telegram = new TelegramClient({
      botToken: "bot",
      fetch: vi.fn(async () => {
        messages += 1;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const first = await sendDeadlineReminders({
      db,
      telegram,
      chatId: "1",
      now,
      listExisting: async () => [...rows.values()],
    });
    expect(first.reminded).toBe(1);
    expect(messages).toBe(1);
    expect(rows.get("soon")?.reminder_sent).toBe(true);
    expect(rows.get("soon")?.reminder_tiers_sent).toEqual(
      expect.arrayContaining(["12h", "6h"]),
    );

    const second = await sendDeadlineReminders({
      db,
      telegram,
      chatId: "1",
      now,
      listExisting: async () => [...rows.values()],
    });
    expect(second.reminded).toBe(0);
    expect(messages).toBe(1);
  });

  it("does not remind when deadline already passed", async () => {
    const { db, rows } = alertStore([
      driveRow({
        id: "late",
        deadline: new Date(now.getTime() - 60_000).toISOString(),
      }),
    ]);
    let messages = 0;
    const telegram = new TelegramClient({
      botToken: "bot",
      fetch: vi.fn(async () => {
        messages += 1;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const result = await sendDeadlineReminders({
      db,
      telegram,
      chatId: "1",
      now,
      listExisting: async () => [...rows.values()],
    });
    expect(result.reminded).toBe(0);
    expect(messages).toBe(0);
  });

  it("skips Not Applied drives", async () => {
    const deadline = new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString();
    const { db, rows } = alertStore([
      driveRow({ id: "na", deadline, status: "Not Applied" }),
    ]);
    const telegram = new TelegramClient({
      botToken: "bot",
      fetch: vi.fn(async () => {
        throw new Error("should not send");
      }) as unknown as typeof fetch,
    });

    const result = await sendDeadlineReminders({
      db,
      telegram,
      chatId: "1",
      now,
      listExisting: async () => [...rows.values()],
    });
    expect(result.reminded).toBe(0);
  });
});
