import { describe, expect, it, vi } from "vitest";
import { beginOtpAfterApprove, completeOtp } from "../app/auth/otp.ts";
import type { Config } from "../app/config.ts";
import { GmailClient } from "../app/gmail/client.ts";
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
    login_wait_state: "awaiting_approval",
    login_wait_notified_at: "2026-01-01T00:00:00.000Z",
    otp_sent_at: null,
    otp_paste_prompted_at: null,
    ...seed,
  };
  const logged: Array<Record<string, unknown>> = [];
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
  return { db: db as never, row, logged };
}

describe("OTP flow", () => {
  it("Approve + Gmail OTP restores session without logging the code", async () => {
    const { db, row } = secretMemory();
    const logObjs: Array<Record<string, unknown>> = [];
    const log = {
      info: (obj: Record<string, unknown>) => {
        logObjs.push(obj);
      },
      warn: (obj: Record<string, unknown>) => {
        logObjs.push(obj);
      },
    };

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("validatestudent")) {
        return new Response(JSON.stringify({ success: true, studentData: { studentID: "PES1UG00FAKE" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("sendOtp")) {
        return new Response(JSON.stringify({ success: true, email: "a@b.com" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("verifyOtp")) {
        return new Response(
          JSON.stringify({
            success: true,
            token: "otp-token",
            studentData: { studentID: "PES1UG00FAKE", batch: 2027 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("no", { status: 404 });
    });

    const gmailFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/messages?") || url.includes("/messages&")) {
        return new Response(JSON.stringify({ messages: [{ id: "m1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/messages/m1")) {
        return new Response(
          JSON.stringify({
            id: "m1",
            internalDate: String(Date.now()),
            snippet: "Your code is 654321",
            payload: { headers: [{ name: "Subject", value: "OTP" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("no", { status: 404 });
    });

    const sendMessage = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const placement = new PlacementClient({ fetch: fetchMock as unknown as typeof fetch });
    const gmail = new GmailClient({
      clientId: "id",
      clientSecret: "sec",
      refreshToken: "ref",
      fetch: gmailFetch as unknown as typeof fetch,
      log,
    });
    const telegram = { sendMessage } as unknown as TelegramClient;

    const result = await beginOtpAfterApprove({
      config: baseConfig,
      db,
      placement,
      telegram,
      gmail,
      log,
      otpTimeoutMs: 1000,
      otpIntervalMs: 10,
      sleep: async () => undefined,
    });

    expect(result).toEqual({ kind: "restored" });
    expect(row.bearer_token).toBe("otp-token");
    expect(row.login_wait_state).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith("9990001111", "Session restored.");
    const blob = JSON.stringify(logObjs);
    expect(blob).not.toContain("654321");
  });

  it("prompts paste once when Gmail is unavailable", async () => {
    const { db, row } = secretMemory();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("validatestudent")) {
        return new Response(JSON.stringify({ success: true, studentData: { studentID: "PES1UG00FAKE" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("sendOtp")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });
    const sendMessage = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const placement = new PlacementClient({ fetch: fetchMock as unknown as typeof fetch });
    const telegram = { sendMessage } as unknown as TelegramClient;

    const first = await beginOtpAfterApprove({
      config: baseConfig,
      db,
      placement,
      telegram,
      otpTimeoutMs: 1,
      otpIntervalMs: 1,
      sleep: async () => undefined,
    });
    expect(first).toEqual({ kind: "need_paste" });
    expect(row.login_wait_state).toBe("awaiting_otp");
    expect(sendMessage).toHaveBeenCalledWith("9990001111", "Paste the OTP from your PESU email.");

    // Paste completes.
    const verifyFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          token: "pasted-token",
          studentData: { studentID: "PES1UG00FAKE" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const placement2 = new PlacementClient({ fetch: verifyFetch as unknown as typeof fetch });
    const pasted = await completeOtp(
      { config: baseConfig, db, placement: placement2, telegram },
      "112233",
    );
    expect(pasted).toEqual({ kind: "restored" });
    expect(row.bearer_token).toBe("pasted-token");
  });
});
