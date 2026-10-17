import { describe, expect, it, vi } from "vitest";
import { skipDrive, skipReplyText } from "../app/apply/skip.ts";
import type { Config } from "../app/config.ts";
import type { DriveRow } from "../app/db/drive.ts";
import { driveActionKeyboard } from "../app/telegram/buttons.ts";
import { TelegramClient } from "../app/telegram/client.ts";
import { handleTelegramUpdate } from "../app/telegram/handlers.ts";
import { sendDeadlineReminders } from "../app/poll/reminders.ts";

const chatId = "9990001111";

const baseConfig = {
  HOST: "0.0.0.0",
  PORT: 10000,
  LOG_LEVEL: "silent",
  CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
  PLACEMENT_STUDENT_ID: "PES1UG00FAKE",
  PLACEMENT_PASSWORD: "secret-pass",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  TELEGRAM_BOT_TOKEN: "bot-token",
  TELEGRAM_ALLOWED_CHAT_ID: chatId,
  TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-secret-0123456789abcdef",
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
    ...partial,
  };
}

function applyStore(seed: DriveRow[]) {
  const rows = new Map(seed.map((r) => [r.id, structuredClone(r)]));
  const db = {
    from(table: string) {
      if (table === "profile") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  student_id: "PES1UG00FAKE",
                  platform: {},
                  platform_synced_at: null,
                  manual: {},
                  canonical_latex: null,
                  canonical_latex_updated_at: null,
                  onboarding: {},
                },
                error: null,
              }),
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
              in(_col: string, ids: string[]) {
                for (const id of ids) {
                  const prev = rows.get(id);
                  const statusFilter = filters.find((f) => f[0] === "status");
                  // status filter applied via chained .eq after .in in markNotApplied
                  if (prev) {
                    rows.set(id, { ...prev, ...payload } as DriveRow);
                  }
                  void statusFilter;
                }
                return {
                  eq: async (col: string, val: string) => {
                    if (col === "status") {
                      for (const id of ids) {
                        const prev = seed.find((r) => r.id === id);
                        const current = rows.get(id);
                        if (current && prev && prev.status !== val) {
                          // revert if was not New before this update batch — keep simple: re-check
                        }
                        if (current && current.status === "Not Applied" && val === "New") {
                          // already applied payload; ensure only New moved
                        }
                      }
                      // Re-apply only for ids that were New in seed at update time
                      for (const id of ids) {
                        const before = seed.find((s) => s.id === id);
                        if (before && before.status !== "New") {
                          rows.set(id, structuredClone(before));
                        }
                      }
                    }
                    return { error: null };
                  },
                };
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
                    if (!prev || (statusFilter && prev.status !== statusFilter[1])) {
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
                  const statusFilter = filters.find((f) => f[0] === "status");
                  if (prev && (!statusFilter || prev.status === statusFilter[1])) {
                    rows.set(idFilter[1], { ...prev, ...payload } as DriveRow);
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

function tgClient(sent: string[]) {
  return new TelegramClient({
    botToken: "bot",
    fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (typeof body.text === "string") {
        sent.push(body.text);
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
}

describe("driveActionKeyboard Skip", () => {
  it("puts Skip on the second row", () => {
    const kb = driveActionKeyboard("drive-1") as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(kb.inline_keyboard).toHaveLength(2);
    expect(kb.inline_keyboard[0]!.map((b) => b.text)).toEqual(["Prepare", "Apply"]);
    expect(kb.inline_keyboard[1]).toEqual([{ text: "Skip", callback_data: "s:drive-1" }]);
  });
});

describe("skipDrive", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");

  it("moves New to Not Applied", async () => {
    const { db, rows } = applyStore([driveRow({ id: "d1" })]);
    const result = await skipDrive({ config: baseConfig, db, now }, "d1");
    expect(result).toEqual({ kind: "skipped", company: "Acme" });
    expect(rows.get("d1")?.status).toBe("Not Applied");
    expect(skipReplyText(result)).toBe("Skipped: Acme.");
  });

  it("no-ops when not New", async () => {
    const { db, rows } = applyStore([driveRow({ id: "d1", status: "Applied" })]);
    const result = await skipDrive({ config: baseConfig, db, now }, "d1");
    expect(result.kind).toBe("not_new");
    expect(rows.get("d1")?.status).toBe("Applied");
  });
});

describe("Telegram Skip", () => {
  it("handles skip callback", async () => {
    const { db } = applyStore([driveRow({ id: "drive-1" })]);
    const sent: string[] = [];
    const result = await handleTelegramUpdate(
      {
        telegram: tgClient(sent),
        allowedChatId: chatId,
        config: baseConfig,
        db,
      },
      {
        callback_query: {
          id: "cq1",
          data: "s:drive-1",
          message: { chat: { id: chatId } },
        },
      },
    );
    expect(result).toEqual({ handled: true, reason: "skip_skipped" });
    expect(sent).toContain("Skipped: Acme.");
  });

  it("free-text skip with one New skips that drive", async () => {
    const { db, rows } = applyStore([driveRow({ id: "only" })]);
    const sent: string[] = [];
    const result = await handleTelegramUpdate(
      {
        telegram: tgClient(sent),
        allowedChatId: chatId,
        config: baseConfig,
        db,
      },
      { message: { chat: { id: chatId }, text: "won't apply" } },
    );
    expect(result.reason).toBe("skip_skipped");
    expect(rows.get("only")?.status).toBe("Not Applied");
  });

  it("free-text skip with multiple New asks which", async () => {
    const { db } = applyStore([
      driveRow({ id: "d1", company_name: "One" }),
      driveRow({ id: "d2", company_name: "Two" }),
    ]);
    const bodies: unknown[] = [];
    const telegram = new TelegramClient({
      botToken: "bot",
      fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        bodies.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const result = await handleTelegramUpdate(
      { telegram, allowedChatId: chatId, config: baseConfig, db },
      { message: { chat: { id: chatId }, text: "skip" } },
    );
    expect(result.reason).toBe("skip_ask_which");
    const joined = JSON.stringify(bodies);
    expect(joined).toContain("Which drive?");
    expect(joined).toContain("s:d1");
    expect(joined).toContain("s:d2");
  });

  it("does not remind a skipped drive", async () => {
    const now = new Date("2026-10-16T00:00:00.000Z");
    const deadline = new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString();
    const { db, rows } = applyStore([
      driveRow({ id: "soon", deadline, status: "Not Applied", reminder_sent: false }),
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
});
