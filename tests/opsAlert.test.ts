import { describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../app/telegram/client.ts";
import { notifyPollOps, resetOpsAlertKeys, sendOpsAlertOnce } from "../app/telegram/ops.ts";

function tgCapture(sent: string[]) {
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

describe("ops alerts", () => {
  it("sends poll failure once per key", async () => {
    resetOpsAlertKeys();
    const sent: string[] = [];
    const deps = { telegram: tgCapture(sent), chatId: "1" };
    await notifyPollOps(deps, { ok: false, alert: "http", alerts: [] });
    await notifyPollOps(deps, { ok: false, alert: "http", alerts: [] });
    expect(sent).toEqual(["Poll failed: http"]);
  });

  it("skips login-wait alerts", async () => {
    resetOpsAlertKeys();
    const sent: string[] = [];
    await notifyPollOps(
      { telegram: tgCapture(sent), chatId: "1" },
      { ok: false, alert: "awaiting_otp", alerts: [] },
    );
    expect(sent).toEqual([]);
  });

  it("alerts on rateLimited once", async () => {
    resetOpsAlertKeys();
    const sent: string[] = [];
    const deps = { telegram: tgCapture(sent), chatId: "1" };
    await notifyPollOps(deps, {
      ok: true,
      alerts: ["apply_check:d1:rateLimited"],
    });
    await notifyPollOps(deps, {
      ok: true,
      alerts: ["apply_check:d2:rateLimited"],
    });
    expect(sent).toEqual(["Placement rate-limited; backing off"]);
  });

  it("sendOpsAlertOnce is idempotent until reset", async () => {
    resetOpsAlertKeys();
    const sent: string[] = [];
    const deps = { telegram: tgCapture(sent), chatId: "1" };
    expect(await sendOpsAlertOnce(deps, "k", "hello")).toBe(true);
    expect(await sendOpsAlertOnce(deps, "k", "hello")).toBe(false);
    expect(sent).toEqual(["hello"]);
  });
});
