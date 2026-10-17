import { describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../app/telegram/client.ts";
import {
  formatHelpReply,
  handleTelegramUpdate,
  isHelpCommand,
} from "../app/telegram/handlers.ts";

const chatId = "9990001111";

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

describe("isHelpCommand", () => {
  it("matches /help forms", () => {
    expect(isHelpCommand("/help")).toBe(true);
    expect(isHelpCommand("help")).toBe(true);
    expect(isHelpCommand("/help@MyBot")).toBe(true);
    expect(isHelpCommand("/poll")).toBe(false);
    expect(isHelpCommand("help me")).toBe(false);
  });
});

describe("formatHelpReply", () => {
  it("lists slash commands", () => {
    const text = formatHelpReply();
    expect(text).toContain("/poll");
    expect(text).toContain("/pollreports");
    expect(text).toContain("/profile");
    expect(text).toContain("/syncapplied");
    expect(text).toContain("/help");
  });
});

describe("handleTelegramUpdate help", () => {
  it("replies with the help text", async () => {
    const sent: string[] = [];
    const result = await handleTelegramUpdate(
      {
        telegram: tgClient(sent),
        allowedChatId: chatId,
      },
      { message: { chat: { id: chatId }, text: "/help" } },
    );
    expect(result).toEqual({ handled: true, reason: "help" });
    expect(sent[0]).toBe(formatHelpReply());
  });
});
