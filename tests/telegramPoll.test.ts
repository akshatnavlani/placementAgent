import { describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.ts";
import type { PollSummary } from "../app/poll/runPoll.ts";
import { TelegramClient } from "../app/telegram/client.ts";
import {
  formatPollReply,
  handleTelegramUpdate,
  isPollCommand,
} from "../app/telegram/handlers.ts";

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

function emptyOk(partial: Partial<PollSummary> = {}): PollSummary {
  return {
    ok: true,
    alerts: [],
    inserted: 0,
    refreshed: 0,
    touched: 0,
    notApplied: 0,
    detailsFetched: 0,
    pdfsFetched: 0,
    notified: 0,
    notionSynced: 0,
    reminded: 0,
    applyChecked: 0,
    markedApplied: 0,
    ...partial,
  };
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

describe("isPollCommand", () => {
  it("matches /poll, poll, and @bot form", () => {
    expect(isPollCommand("/poll")).toBe(true);
    expect(isPollCommand("poll")).toBe(true);
    expect(isPollCommand("/poll@MyBot")).toBe(true);
    expect(isPollCommand("/profile")).toBe(false);
    expect(isPollCommand("poll now")).toBe(false);
  });
});

describe("formatPollReply", () => {
  it("summarizes success", () => {
    const text = formatPollReply(
      emptyOk({ inserted: 1, refreshed: 2, touched: 3, notified: 1, detailsFetched: 1, pdfsFetched: 2 }),
    );
    expect(text).toContain("Poll done.");
    expect(text).toContain("New: 1 · Updated: 2 · Touched: 3");
    expect(text).toContain("Notified: 1 · Details: 1 · PDFs: 2");
  });

  it("reports failure alert", () => {
    expect(formatPollReply(emptyOk({ ok: false, alert: "rateLimited" }))).toBe(
      "Poll failed: rateLimited",
    );
  });
});

describe("Telegram /poll", () => {
  it("runs manual poll and replies with summary", async () => {
    const sent: string[] = [];
    const runManualPoll = vi.fn(async () =>
      emptyOk({ inserted: 1, notified: 1, detailsFetched: 1 }),
    );
    const result = await handleTelegramUpdate(
      {
        telegram: tgClient(sent),
        allowedChatId: chatId,
        config: baseConfig,
        runManualPoll,
      },
      { message: { chat: { id: chatId }, text: "/poll" } },
    );
    expect(result).toEqual({ handled: true, reason: "poll_ok" });
    expect(runManualPoll).toHaveBeenCalledOnce();
    expect(sent[0]).toBe("Polling…");
    expect(sent[1]).toContain("Poll done.");
    expect(sent[1]).toContain("New: 1");
  });

  it("reports poll failure", async () => {
    const sent: string[] = [];
    const result = await handleTelegramUpdate(
      {
        telegram: tgClient(sent),
        allowedChatId: chatId,
        config: baseConfig,
        runManualPoll: async () => emptyOk({ ok: false, alert: "awaiting_login_approval" }),
      },
      { message: { chat: { id: chatId }, text: "poll" } },
    );
    expect(result.reason).toBe("poll_failed");
    expect(sent.at(-1)).toBe("Poll failed: awaiting_login_approval");
  });

  it("rejects when unconfigured", async () => {
    const sent: string[] = [];
    const result = await handleTelegramUpdate(
      {
        telegram: tgClient(sent),
        allowedChatId: chatId,
      },
      { message: { chat: { id: chatId }, text: "/poll" } },
    );
    expect(result.reason).toBe("poll_unconfigured");
    expect(sent).toContain("Poll is not configured yet.");
  });
});
