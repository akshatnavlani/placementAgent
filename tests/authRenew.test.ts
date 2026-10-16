import { describe, expect, it, vi } from "vitest";
import { renewFromUnauthorized } from "../app/auth/renew.ts";
import type { Config } from "../app/config.ts";
import { PlacementClient } from "../app/placement/client.ts";
import { TelegramClient } from "../app/telegram/client.ts";

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
  TELEGRAM_ALLOWED_CHAT_ID: "9990001111",
  TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-secret-0123456789abcdef",
} as Config;

function secretMemory(seed: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: 1,
    bearer_token: null,
    token_obtained_at: null,
    token_source: null,
    login_wait_state: null,
    login_wait_notified_at: null,
    otp_sent_at: null,
    otp_paste_prompted_at: null,
    ...seed,
  };
  const db = {
    from(table: string) {
      if (table === "secret") {
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
          upsert: async (payload: Record<string, unknown>) => {
            Object.assign(row, payload);
            return { error: null };
          },
        };
      }
      if (table === "profile") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: 1 }, error: null }),
            }),
          }),
          update: () => ({
            eq: async () => ({ error: null }),
          }),
          insert: async () => ({ error: null }),
        };
      }
      throw new Error(`unexpected ${table}`);
    },
  };
  return { db: db as never, row };
}

describe("renewFromUnauthorized", () => {
  it("stores token and notifies once on password renew", async () => {
    const { db, row } = secretMemory();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          token: "new-token",
          studentData: { studentID: "PES1UG00FAKE", batch: 2027 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const sendMessage = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const placement = new PlacementClient({ fetch: fetchMock as unknown as typeof fetch });
    const telegram = { sendMessage } as unknown as TelegramClient;

    const result = await renewFromUnauthorized({
      config: baseConfig,
      db,
      placement,
      telegram,
    });

    expect(result).toEqual({ kind: "renewed" });
    expect(row.bearer_token).toBe("new-token");
    expect(row.login_wait_state).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith("9990001111", "Session renewed.");
  });

  it("sends waiting message once; second renew does not spam", async () => {
    const { db, row } = secretMemory();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          studentData: { studentID: "PES1UG00FAKE" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const sendMessage = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const placement = new PlacementClient({ fetch: fetchMock as unknown as typeof fetch });
    const telegram = { sendMessage } as unknown as TelegramClient;

    const first = await renewFromUnauthorized({ config: baseConfig, db, placement, telegram });
    const second = await renewFromUnauthorized({ config: baseConfig, db, placement, telegram });

    expect(first).toEqual({ kind: "waiting" });
    expect(second).toEqual({ kind: "waiting" });
    expect(row.login_wait_state).toBe("awaiting_approval");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "9990001111",
      "Logged out, waiting for approval.",
      expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    );
  });

  it("joins awaiting_otp without validateStudent spam path returning awaiting_otp", async () => {
    const { db } = secretMemory({ login_wait_state: "awaiting_otp" });
    const fetchMock = vi.fn();
    const placement = new PlacementClient({ fetch: fetchMock as unknown as typeof fetch });
    const result = await renewFromUnauthorized({ config: baseConfig, db, placement });
    expect(result).toEqual({ kind: "awaiting_otp" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
