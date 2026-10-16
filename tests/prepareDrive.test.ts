import { describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.ts";
import { prepareDrive, prepareReplyText } from "../app/draft/prepare.ts";
import type { DriveRow } from "../app/db/drive.ts";
import { TelegramClient } from "../app/telegram/client.ts";

const baseConfig = {
  HOST: "0.0.0.0",
  PORT: 10000,
  LOG_LEVEL: "silent",
  CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
  PLACEMENT_STUDENT_ID: "PES1UG00FAKE",
  PLACEMENT_PASSWORD: "secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  TELEGRAM_BOT_TOKEN: "bot",
  TELEGRAM_ALLOWED_CHAT_ID: "1",
  TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-secret-0123456789abcdef",
  CURSOR_WEBHOOK_URL: "https://cursor.example/webhook",
  CURSOR_WEBHOOK_SECRET: "cursor-secret",
  DRAFT_CALLBACK_SECRET: "draft-callback-secret-0123456789abcdef0123",
  PUBLIC_BASE_URL: "https://pesu-placement-watcher.onrender.com",
} as Config;

function driveRow(partial: Partial<DriveRow> & { id: string }): DriveRow {
  return {
    raw_list: { companyName: "Acme", eventName: "SDE" },
    raw_detail: { customFields: [] },
    updated_at_platform: null,
    is_eligible: true,
    deadline: null,
    status: "New",
    reminder_sent: false,
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
    ...partial,
  };
}

function prepareStore(seed: DriveRow, opts: { latex?: string | null } = {}) {
  const drive = structuredClone(seed);
  const drafts: Array<Record<string, unknown>> = [];
  const answers: Array<Record<string, unknown>> = [];
  const profile = {
    student_id: "PES1UG00FAKE",
    platform: { name: "Ada" },
    platform_synced_at: "2026-01-01T00:00:00.000Z",
    manual: {},
    canonical_latex: opts.latex === undefined ? "\\documentclass{article}" : opts.latex,
    canonical_latex_updated_at: "2026-01-01T00:00:00.000Z",
    onboarding: {},
  };

  const db = {
    from(table: string) {
      if (table === "drive") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => ({
                data: id === drive.id ? drive : null,
                error: null,
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: async (_c: string, id: string) => {
              if (id === drive.id) {
                Object.assign(drive, payload);
              }
              return { error: null };
            },
          }),
        };
      }
      if (table === "profile") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { ...profile }, error: null }),
            }),
          }),
        };
      }
      if (table === "answer") {
        return {
          select: () => ({
            then: (resolve: (v: { data: typeof answers; error: null }) => unknown) =>
              Promise.resolve(resolve({ data: answers, error: null })),
          }),
          insert: async (payload: Record<string, unknown>) => {
            answers.push({
              id: `a${answers.length + 1}`,
              approved: true,
              reusable: true,
              drive_id: null,
              ...payload,
            });
            return { error: null };
          },
          update: (payload: Record<string, unknown>) => ({
            eq: async (_c: string, id: string) => {
              const row = answers.find((a) => a.id === id);
              if (row) {
                Object.assign(row, payload);
              }
              return { error: null };
            },
          }),
        };
      }
      if (table === "draft") {
        return {
          insert: async (payload: Record<string, unknown>) => {
            drafts.push({
              id: `d${drafts.length + 1}`,
              created_at: payload.created_at,
              updated_at: payload.updated_at,
              ...payload,
            });
            return { error: null };
          },
          select: () => {
            const api = {
              eq(_c: string, driveId: string) {
                const matches = drafts
                  .filter((d) => d.drive_id === driveId)
                  .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
                return {
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({ data: matches[0] ?? null, error: null }),
                    }),
                  }),
                  maybeSingle: async () => ({ data: matches[0] ?? null, error: null }),
                  eq(col: string, val: string) {
                    return {
                      select: () => ({
                        maybeSingle: async () => {
                          const row = matches[0];
                          if (row && row[col] === val) {
                            return { data: row, error: null };
                          }
                          return { data: null, error: null };
                        },
                      }),
                      then: async (resolve: (v: { data: unknown; error: null }) => unknown) =>
                        resolve({ data: null, error: null }),
                    };
                  },
                };
              },
            };
            return api;
          },
          update: (payload: Record<string, unknown>) => ({
            eq(_c: string, id: string) {
              return {
                eq(col: string, val: string) {
                  const row = drafts.find((d) => d.id === id);
                  if (row && row[col] === val) {
                    Object.assign(row, payload);
                  }
                  return {
                    select: () => ({
                      maybeSingle: async () => ({
                        data: row && row.status === payload.status ? row : row,
                        error: null,
                      }),
                    }),
                  };
                },
              };
            },
          }),
        };
      }
      throw new Error(`unexpected ${table}`);
    },
  };

  return { db: db as never, drive, drafts };
}

function tg() {
  return new TelegramClient({
    botToken: "bot",
    fetch: vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    ) as unknown as typeof fetch,
  });
}

describe("prepareDrive", () => {
  it("returns already_pending", async () => {
    const { db } = prepareStore(driveRow({ id: "d1", draft_status: "pending" }));
    const result = await prepareDrive(
      { config: baseConfig, db, telegram: tg(), chatId: "1" },
      "d1",
    );
    expect(result.kind).toBe("already_pending");
    expect(prepareReplyText(result)).toBe("Already preparing.");
  });

  it("returns missing_latex", async () => {
    const { db } = prepareStore(driveRow({ id: "d1" }), { latex: null });
    const result = await prepareDrive(
      { config: baseConfig, db, telegram: tg(), chatId: "1" },
      "d1",
    );
    expect(result.kind).toBe("missing_latex");
  });

  it("returns not_configured without env", async () => {
    const { db } = prepareStore(driveRow({ id: "d1" }));
    const config = { ...baseConfig, CURSOR_WEBHOOK_URL: undefined } as Config;
    const result = await prepareDrive(
      { config, db, telegram: tg(), chatId: "1" },
      "d1",
    );
    expect(result.kind).toBe("not_configured");
  });

  it("returns need_answers when required fields are missing", async () => {
    const { db } = prepareStore(
      driveRow({
        id: "d1",
        raw_detail: {
          customFields: [{ label: "Why us?", type: "text", required: true }],
        },
      }),
    );
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    const result = await prepareDrive(
      { config: baseConfig, db, telegram: tg(), chatId: "1", fetch: fetchMock as unknown as typeof fetch },
      "d1",
    );
    expect(result.kind).toBe("need_answers");
    if (result.kind === "need_answers") {
      expect(result.fields.map((f) => f.label)).toEqual(["Why us?"]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks pending on webhook success", async () => {
    const { db, drive, drafts } = prepareStore(driveRow({ id: "d1" }));
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    const result = await prepareDrive(
      { config: baseConfig, db, telegram: tg(), chatId: "1", fetch: fetchMock as unknown as typeof fetch },
      "d1",
    );
    expect(result.kind).toBe("preparing");
    expect(drive.draft_status).toBe("pending");
    expect(drafts[0]?.status).toBe("pending");
    expect(fetchMock).toHaveBeenCalled();
    const joined = JSON.stringify(fetchMock.mock.calls);
    expect(joined).toContain("/draft/callback");
    expect(joined).toContain("d1");
    expect(joined).toContain(baseConfig.DRAFT_CALLBACK_SECRET);
  });

  it("marks failed on webhook error", async () => {
    const { db, drive } = prepareStore(driveRow({ id: "d1" }));
    const fetchMock = vi.fn(async () => new Response("no", { status: 500 }));
    const result = await prepareDrive(
      { config: baseConfig, db, telegram: tg(), chatId: "1", fetch: fetchMock as unknown as typeof fetch },
      "d1",
    );
    expect(result.kind).toBe("webhook_failed");
    expect(drive.draft_status).toBe("failed");
  });
});
