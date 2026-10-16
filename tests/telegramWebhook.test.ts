import { afterAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../app/config.ts";
import { buildServer } from "../app/server.ts";

const secret = "test-cron-secret-0123456789abcdef0123456789";
const webhookSecret = "telegram-webhook-secret-0123456789abcdef";

const app = buildServer(
  loadConfig({
    CRON_SHARED_SECRET: secret,
    LOG_LEVEL: "silent",
    TELEGRAM_BOT_TOKEN: "123:ABC",
    TELEGRAM_ALLOWED_CHAT_ID: "2020704195",
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
  }),
);

afterAll(async () => {
  await app.close();
});

describe("POST /telegram/webhook", () => {
  it("rejects a wrong secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "wrong", "content-type": "application/json" },
      payload: { update_id: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("ignores wrong chat and still returns 200", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: {
          "x-telegram-bot-api-secret-token": webhookSecret,
          "content-type": "application/json",
        },
        payload: {
          update_id: 2,
          callback_query: {
            id: "cq1",
            data: "p:drive1",
            message: { chat: { id: 999 } },
          },
        },
      });
      expect(res.statusCode).toBe(200);
      // Wrong chat → handler does not call Bot API.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("answers Prepare stub for the allowed chat", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: {
          "x-telegram-bot-api-secret-token": webhookSecret,
          "content-type": "application/json",
        },
        payload: {
          update_id: 3,
          callback_query: {
            id: "cq2",
            data: "p:6ad05fd6b7a2c9401084f819",
            message: { chat: { id: 2020704195 } },
          },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
      const joined = JSON.stringify(fetchMock.mock.calls);
      expect(joined).toContain("Drafting not enabled yet");
    } finally {
      globalThis.fetch = original;
    }
  });
});
