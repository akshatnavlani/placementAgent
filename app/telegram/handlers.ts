import type { TelegramClient } from "./client.ts";
import { decodeCallback } from "./buttons.ts";

export type TelegramUpdate = {
  update_id?: number;
  message?: {
    chat?: { id?: number | string };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number };
    message?: { chat?: { id?: number | string } };
  };
};

export type HandleUpdateResult = {
  handled: boolean;
  reason?: string;
};

export async function handleTelegramUpdate(
  deps: {
    telegram: TelegramClient;
    allowedChatId: string;
  },
  update: TelegramUpdate,
): Promise<HandleUpdateResult> {
  const callback = update.callback_query;
  if (callback) {
    const chatId = String(callback.message?.chat?.id ?? "");
    if (chatId !== deps.allowedChatId) {
      return { handled: false, reason: "wrong_chat" };
    }
    const decoded = decodeCallback(callback.data ?? "");
    if (!decoded) {
      await deps.telegram.answerCallbackQuery(callback.id, "Unknown action");
      return { handled: true, reason: "unknown_callback" };
    }
    if (decoded.kind === "prepare") {
      await deps.telegram.answerCallbackQuery(callback.id, "Drafting not enabled yet");
      await deps.telegram.sendMessage(deps.allowedChatId, "Drafting not enabled yet.");
      return { handled: true };
    }
    await deps.telegram.answerCallbackQuery(callback.id, "Apply verify not enabled yet");
    await deps.telegram.sendMessage(deps.allowedChatId, "Apply verify not enabled yet.");
    return { handled: true };
  }

  const message = update.message;
  if (message) {
    const chatId = String(message.chat?.id ?? "");
    if (chatId !== deps.allowedChatId) {
      return { handled: false, reason: "wrong_chat" };
    }
    // Ignore free text in M3 (I applied free-text is M6).
    return { handled: true, reason: "message_ignored" };
  }

  return { handled: false, reason: "ignored" };
}
