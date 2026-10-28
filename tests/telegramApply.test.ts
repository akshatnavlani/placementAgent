import { describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.ts";
import type { DriveRow } from "../app/db/drive.ts";
import { PlacementClient } from "../app/placement/client.ts";
import { TelegramClient } from "../app/telegram/client.ts";
import { handleTelegramUpdate } from "../app/telegram/handlers.ts";

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
    draft_status: "ready",
    notion_page_id: null,
    pdf_urls: [],
    pdf_text: {},
    company_id: null,
    company_name: "Acme",
    company_username: "acme",
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

function applyStore(seed: DriveRow[]) {
  const rows = new Map(seed.map((r) => [r.id, structuredClone(r)]));
  const drafts = new Map(
    seed.map((r) => [
      r.id,
      {
        id: `draft-${r.id}`,
        drive_id: r.id,
        status: "ready",
        latex: "\\documentclass{article}\\begin{document}x\\end{document}",
        answers: [],
        error: null,
        callback_at: null,
        delivered_at: "2026-01-01T00:00:00.000Z",
        request_payload: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ]),
  );
  const secretRow: Record<string, unknown> = {
    id: 1,
    bearer_token: "tok",
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
      if (table === "profile") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  student_id: "PES1UG00FAKE",
                  platform: { fullName: "Ada Lovelace" },
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
      if (table === "answer") {
        return {
          select: () => ({
            then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
              Promise.resolve(resolve({ data: [], error: null })),
          }),
        };
      }
      if (table === "draft") {
        return {
          select: () => ({
            eq: (_c: string, driveId: string) => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: drafts.get(driveId) ?? null, error: null }),
                }),
              }),
              maybeSingle: async () => ({ data: drafts.get(driveId) ?? null, error: null }),
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
                  if (prev) {
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

function placementFetch(applied: boolean) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("uploadEventResume")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("studentevents/apply")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ applied }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
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

describe("Telegram Apply", () => {
  it("submits via applied callback", async () => {
    const { db } = applyStore([driveRow({ id: "drive-1" })]);
    const sent: string[] = [];
    const placement = new PlacementClient({
      fetch: placementFetch(false),
    });

    const result = await handleTelegramUpdate(
      {
        telegram: tgClient(sent),
        allowedChatId: chatId,
        config: baseConfig,
        db,
        placement,
        fetch: placementFetch(false),
      },
      {
        callback_query: {
          id: "cq1",
          data: "a:drive-1",
          message: { chat: { id: chatId } },
        },
      },
    );

    expect(result.reason).toMatch(/^apply_/);
    expect(sent.some((t) => t.includes("application") || t.includes("Applied") || t.includes("PDF"))).toBe(
      true,
    );
  });

  it("free-text with one New applies that drive", async () => {
    const { db } = applyStore([driveRow({ id: "only" })]);
    const sent: string[] = [];
    const fetchImpl = placementFetch(true);
    const placement = new PlacementClient({ fetch: fetchImpl });

    const result = await handleTelegramUpdate(
      {
        telegram: tgClient(sent),
        allowedChatId: chatId,
        config: baseConfig,
        db,
        placement,
        fetch: fetchImpl,
      },
      { message: { chat: { id: chatId }, text: "Apply" } },
    );

    expect(["apply_applied", "apply_pdf_failed"].includes(result.reason!)).toBe(true);
  });

  it("free-text with multiple New asks which drive", async () => {
    const { db } = applyStore([
      driveRow({ id: "d1", company_name: "One" }),
      driveRow({ id: "d2", company_name: "Two" }),
    ]);
    const sent: string[] = [];
    const bodies: unknown[] = [];
    const telegram = new TelegramClient({
      botToken: "bot",
      fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        bodies.push(body);
        if (typeof body.text === "string") {
          sent.push(body.text);
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const result = await handleTelegramUpdate(
      {
        telegram,
        allowedChatId: chatId,
        config: baseConfig,
        db,
        placement: new PlacementClient({ fetch: vi.fn() as unknown as typeof fetch }),
      },
      { message: { chat: { id: chatId }, text: "i applied" } },
    );

    expect(result.reason).toBe("apply_ask_which");
    expect(sent).toContain("Which drive?");
    const joined = JSON.stringify(bodies);
    expect(joined).toContain("a:d1");
    expect(joined).toContain("a:d2");
  });

  it("ignores non-matching free text", async () => {
    const { db } = applyStore([driveRow({ id: "d1" })]);
    const result = await handleTelegramUpdate(
      {
        telegram: tgClient([]),
        allowedChatId: chatId,
        config: baseConfig,
        db,
        placement: new PlacementClient({ fetch: vi.fn() as unknown as typeof fetch }),
      },
      { message: { chat: { id: chatId }, text: "hello there" } },
    );
    expect(result).toEqual({ handled: true, reason: "message_ignored" });
  });

  it("reports no New drives", async () => {
    const { db } = applyStore([driveRow({ id: "d1", status: "Applied" })]);
    const sent: string[] = [];
    const result = await handleTelegramUpdate(
      {
        telegram: tgClient(sent),
        allowedChatId: chatId,
        config: baseConfig,
        db,
        placement: new PlacementClient({ fetch: vi.fn() as unknown as typeof fetch }),
      },
      { message: { chat: { id: chatId }, text: "I applied" } },
    );
    expect(result.reason).toBe("apply_none");
    expect(sent).toContain("No New drives to apply to.");
  });
});
