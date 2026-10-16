import { describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.ts";
import { handleDraftCallback } from "../app/draft/callback.ts";
import type { DriveRow } from "../app/db/drive.ts";
import { buildServer } from "../app/server.ts";
import { loadConfig } from "../app/config.ts";

const secret = "draft-callback-secret-0123456789abcdef0123";

const baseConfig = {
  HOST: "0.0.0.0",
  PORT: 10000,
  LOG_LEVEL: "silent",
  CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  TELEGRAM_BOT_TOKEN: "bot",
  TELEGRAM_ALLOWED_CHAT_ID: "999",
  TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-secret-0123456789abcdef",
  DRAFT_CALLBACK_SECRET: secret,
  PUBLIC_BASE_URL: "https://example.com",
} as Config;

function callbackStore(seed: DriveRow) {
  const drive = structuredClone(seed);
  const drafts: Array<Record<string, unknown>> = [
    {
      id: "draft-1",
      drive_id: drive.id,
      status: "pending",
      latex: null,
      answers: [],
      error: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ];

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
      if (table === "draft") {
        return {
          select: () => ({
            eq: (_c: string, driveId: string) => {
              const matches = drafts.filter((d) => d.drive_id === driveId);
              return {
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: matches[0] ?? null, error: null }),
                  }),
                }),
                maybeSingle: async () => ({ data: matches[0] ?? null, error: null }),
              };
            },
          }),
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
                      maybeSingle: async () => ({ data: row ?? null, error: null }),
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

describe("handleDraftCallback", () => {
  it("marks ready on success", async () => {
    const { db, drive, drafts } = callbackStore({
      id: "drive-1",
      raw_list: {},
      raw_detail: null,
      updated_at_platform: null,
      is_eligible: true,
      deadline: null,
      status: "New",
      reminder_sent: false,
      draft_status: "pending",
      notion_page_id: null,
      pdf_urls: [],
      pdf_text: {},
      company_id: null,
      company_name: "Acme",
      company_username: null,
      event_name: null,
      first_seen_at: "2026-01-01T00:00:00.000Z",
      last_seen_at: "2026-01-01T00:00:00.000Z",
      alerted_at: null,
      applied_at: null,
      last_apply_check_at: null,
    });

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );

    const result = await handleDraftCallback({
      config: baseConfig,
      db,
      body: {
        driveId: "drive-1",
        ok: true,
        latex: "\\documentclass{article}",
        answers: [{ label: "Why us?", value: "Growth" }],
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, status: "ready" });
    expect(drive.draft_status).toBe("ready");
    expect(drafts[0]?.status).toBe("ready");
    expect(drafts[0]?.latex).toContain("documentclass");
  });

  it("rejects when not pending", async () => {
    const { db } = callbackStore({
      id: "drive-1",
      raw_list: {},
      raw_detail: null,
      updated_at_platform: null,
      is_eligible: true,
      deadline: null,
      status: "New",
      reminder_sent: false,
      draft_status: "ready",
      notion_page_id: null,
      pdf_urls: [],
      pdf_text: {},
      company_id: null,
      company_name: "Acme",
      company_username: null,
      event_name: null,
      first_seen_at: "2026-01-01T00:00:00.000Z",
      last_seen_at: "2026-01-01T00:00:00.000Z",
      alerted_at: null,
      applied_at: null,
      last_apply_check_at: null,
    });

    const result = await handleDraftCallback({
      config: baseConfig,
      db,
      body: { driveId: "drive-1", ok: true, latex: "x", answers: [] },
    });
    expect(result.status).toBe(409);
  });
});

describe("POST /draft/callback auth", () => {
  it("rejects missing bearer", async () => {
    const app = buildServer(
      loadConfig({
        CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
        LOG_LEVEL: "silent",
        DRAFT_CALLBACK_SECRET: secret,
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/draft/callback",
      payload: { driveId: "x", latex: "y", answers: [] },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
