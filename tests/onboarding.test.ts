import { describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.ts";
import type { ManualProfile } from "../app/profile/manual.ts";
import { TelegramClient } from "../app/telegram/client.ts";
import { handleTelegramUpdate } from "../app/telegram/handlers.ts";
import { decodeCallback } from "../app/telegram/buttons.ts";
import { profileMenuKeyboard, reviewKeyboard } from "../app/telegram/onboarding.ts";

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

function profileStore(seed: {
  manual?: ManualProfile;
  latex?: string | null;
  onboarding?: Record<string, unknown>;
} = {}) {
  const row: Record<string, unknown> = {
    id: 1,
    student_id: "PES1UG00FAKE",
    platform: { name: "Ada", email: "a@b.com", currentCGPA: 9 },
    platform_synced_at: "2026-01-01T00:00:00.000Z",
    manual: seed.manual ?? {},
    canonical_latex: seed.latex ?? null,
    canonical_latex_updated_at: seed.latex ? "2026-01-01T00:00:00.000Z" : null,
    onboarding: seed.onboarding ?? {},
  };
  const answers: Array<Record<string, unknown>> = [];

  const db = {
    from(table: string) {
      if (table === "profile") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { ...row }, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: async () => {
              Object.assign(row, payload);
              return { error: null };
            },
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
            answers.push({ id: `a${answers.length}`, ...payload });
            return { error: null };
          },
          update: (payload: Record<string, unknown>) => ({
            eq: async (_c: string, id: string) => {
              const idx = answers.findIndex((a) => a.id === id);
              if (idx >= 0) {
                answers[idx] = { ...answers[idx], ...payload };
              }
              return { error: null };
            },
          }),
        };
      }
      if (table === "drive") {
        return {
          select: () => ({
            then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
              Promise.resolve(resolve({ data: [], error: null })),
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      }
      if (table === "secret") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  bearer_token: "tok",
                  login_wait_state: null,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected ${table}`);
    },
  };
  return { db: db as never, row, answers };
}

function tg(sent: string[], bodies: unknown[] = []) {
  return new TelegramClient({
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
}

describe("profile callbacks", () => {
  it("decodes prof and github callbacks", () => {
    expect(decodeCallback("prof:redo")).toEqual({ kind: "profile", action: "redo" });
    expect(decodeCallback("prof:ok")).toEqual({ kind: "profile", action: "ok" });
    expect(decodeCallback("g:ok:2")).toEqual({ kind: "github", action: "ok", index: 2 });
    expect(decodeCallback("g:no:0")).toEqual({ kind: "github", action: "no", index: 0 });
  });

  it("menu keyboards include expected actions", () => {
    expect(JSON.stringify(profileMenuKeyboard())).toContain("prof:redo");
    expect(JSON.stringify(reviewKeyboard())).toContain("prof:ok");
  });
});

describe("Telegram /profile", () => {
  it("starts wizard when profile empty", async () => {
    const { db, row } = profileStore();
    const sent: string[] = [];
    const result = await handleTelegramUpdate(
      { telegram: tg(sent), allowedChatId: chatId, config: baseConfig, db },
      { message: { chat: { id: chatId }, text: "/profile" } },
    );
    expect(result.reason).toBe("profile_menu");
    expect(row.onboarding).toMatchObject({ step: "jee_percentile" });
    expect(sent.some((t) => t.includes("JEE percentile"))).toBe(true);
  });

  it("shows summary menu when latex already set", async () => {
    const { db } = profileStore({
      latex: "\\documentclass{article}",
      manual: { jee: { percentile: "99" } },
    });
    const sent: string[] = [];
    const bodies: unknown[] = [];
    const result = await handleTelegramUpdate(
      { telegram: tg(sent, bodies), allowedChatId: chatId, config: baseConfig, db },
      { message: { chat: { id: chatId }, text: "profile" } },
    );
    expect(result.reason).toBe("profile_menu");
    expect(sent.some((t) => t.includes("Profile summary"))).toBe(true);
    expect(JSON.stringify(bodies)).toContain("prof:redo");
  });

  it("advances a step and cancel clears onboarding", async () => {
    const { db, row } = profileStore({
      onboarding: {
        step: "jee_percentile",
        mode: "fresh",
        draft_manual: {},
      },
    });
    const sent: string[] = [];
    await handleTelegramUpdate(
      { telegram: tg(sent), allowedChatId: chatId, config: baseConfig, db },
      { message: { chat: { id: chatId }, text: "99.5" } },
    );
    expect((row.onboarding as { step?: string }).step).toBe("jee_rank");
    expect((row.onboarding as { draft_manual?: ManualProfile }).draft_manual?.jee?.percentile).toBe(
      "99.5",
    );

    await handleTelegramUpdate(
      { telegram: tg(sent), allowedChatId: chatId, config: baseConfig, db },
      { message: { chat: { id: chatId }, text: "cancel" } },
    );
    expect(row.onboarding).toEqual({});
    expect(sent.some((t) => t.includes("cancelled"))).toBe(true);
  });

  it("redo callback starts wizard", async () => {
    const { db, row } = profileStore({
      latex: "\\documentclass{article}",
      manual: { jee: { percentile: "90" } },
    });
    const result = await handleTelegramUpdate(
      { telegram: tg([]), allowedChatId: chatId, config: baseConfig, db },
      {
        callback_query: {
          id: "cq",
          data: "prof:redo",
          message: { chat: { id: chatId } },
        },
      },
    );
    expect(result.reason).toBe("profile_redo");
    expect(row.onboarding).toMatchObject({ step: "jee_percentile", mode: "redo" });
  });
});
