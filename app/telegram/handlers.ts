import { beginOtpAfterApprove, completeOtp, type OtpDeps } from "../auth/otp.ts";
import type { DbClient } from "../db/client.ts";
import { loadAuthState } from "../db/secret.ts";
import type { PlacementClient } from "../placement/client.ts";
import type { Config } from "../config.ts";
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

export type HandleUpdateDeps = {
  telegram: TelegramClient;
  allowedChatId: string;
  config?: Config;
  db?: DbClient;
  placement?: PlacementClient;
  /** After OTP restores session, optionally run a poll. */
  onSessionRestored?: () => void | Promise<void>;
  log?: OtpDeps["log"];
};

export async function handleTelegramUpdate(
  deps: HandleUpdateDeps,
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
    if (decoded.kind === "approve") {
      await deps.telegram.answerCallbackQuery(callback.id, "Approving…");
      if (!deps.config || !deps.db || !deps.placement) {
        await deps.telegram.sendMessage(deps.allowedChatId, "Login approval is not configured yet.");
        return { handled: true, reason: "approve_unconfigured" };
      }
      const result = await beginOtpAfterApprove({
        config: deps.config,
        db: deps.db,
        placement: deps.placement,
        telegram: deps.telegram,
        log: deps.log,
      });
      if (result.kind === "restored") {
        await deps.onSessionRestored?.();
        return { handled: true, reason: "approve_restored" };
      }
      if (result.kind === "need_paste") {
        return { handled: true, reason: "approve_need_paste" };
      }
      if (result.kind === "wrong_state") {
        await deps.telegram.sendMessage(deps.allowedChatId, "Nothing to approve right now.");
        return { handled: true, reason: "approve_wrong_state" };
      }
      await deps.telegram.sendMessage(deps.allowedChatId, "Could not start login OTP. Try again later.");
      return { handled: true, reason: "approve_failed" };
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
    const text = (message.text ?? "").trim();
    if (/^\d{4,8}$/.test(text) && deps.config && deps.db && deps.placement) {
      const state = await loadAuthState(deps.db);
      if (state.loginWaitState === "awaiting_otp") {
        const result = await completeOtp(
          {
            config: deps.config,
            db: deps.db,
            placement: deps.placement,
            telegram: deps.telegram,
            log: deps.log,
          },
          text,
        );
        if (result.kind === "restored") {
          await deps.onSessionRestored?.();
          return { handled: true, reason: "otp_paste_restored" };
        }
        await deps.telegram.sendMessage(deps.allowedChatId, "That code did not work. Try again.");
        return { handled: true, reason: "otp_paste_failed" };
      }
    }
    return { handled: true, reason: "message_ignored" };
  }

  return { handled: false, reason: "ignored" };
}
