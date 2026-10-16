import { skipDrive, skipReplyText } from "../apply/skip.ts";
import { verifyApplied, verifyReplyText } from "../apply/verify.ts";
import { beginOtpAfterApprove, completeOtp, type OtpDeps } from "../auth/otp.ts";
import type { Config } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { listNewDrives } from "../db/drive.ts";
import { loadAuthState } from "../db/secret.ts";
import type { PlacementClient } from "../placement/client.ts";
import {
  chooseDriveKeyboard,
  chooseSkipDriveKeyboard,
  decodeCallback,
  encodeCallback,
} from "./buttons.ts";
import type { TelegramClient } from "./client.ts";

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

const I_APPLIED_RE = /^\s*i\s*applied\s*[.!?]?\s*$/i;
const SKIP_RE = /^\s*(skip|won'?t\s+apply|wont\s+apply)\s*[.!?]?\s*$/i;

function driveChoiceLabel(company: string | null, eventName: string | null): string {
  const companyPart = company?.trim() || "Unknown";
  const rolePart = eventName?.trim();
  if (rolePart) {
    return `${companyPart} — ${rolePart}`.slice(0, 40);
  }
  return companyPart.slice(0, 40);
}

async function runVerify(
  deps: HandleUpdateDeps,
  driveId: string,
): Promise<{ text: string; reason: string }> {
  if (!deps.config || !deps.db || !deps.placement) {
    return { text: "Apply verify is not configured yet.", reason: "apply_unconfigured" };
  }
  const result = await verifyApplied(
    {
      config: deps.config,
      db: deps.db,
      placement: deps.placement,
      telegram: deps.telegram,
      chatId: deps.allowedChatId,
      log: deps.log,
    },
    driveId,
  );
  return { text: verifyReplyText(result), reason: `apply_${result.kind}` };
}

async function runSkip(
  deps: HandleUpdateDeps,
  driveId: string,
): Promise<{ text: string; reason: string }> {
  if (!deps.config || !deps.db) {
    return { text: "Skip is not configured yet.", reason: "skip_unconfigured" };
  }
  const result = await skipDrive(
    {
      config: deps.config,
      db: deps.db,
      telegram: deps.telegram,
      chatId: deps.allowedChatId,
      log: deps.log,
    },
    driveId,
  );
  return { text: skipReplyText(result), reason: `skip_${result.kind}` };
}

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
    if (decoded.kind === "skip") {
      await deps.telegram.answerCallbackQuery(callback.id, "Skipping…");
      const skipped = await runSkip(deps, decoded.driveId);
      await deps.telegram.sendMessage(deps.allowedChatId, skipped.text);
      return { handled: true, reason: skipped.reason };
    }
    // applied
    await deps.telegram.answerCallbackQuery(callback.id, "Checking…");
    const verified = await runVerify(deps, decoded.driveId);
    await deps.telegram.sendMessage(deps.allowedChatId, verified.text);
    return { handled: true, reason: verified.reason };
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

    if (I_APPLIED_RE.test(text)) {
      if (!deps.db) {
        await deps.telegram.sendMessage(deps.allowedChatId, "Apply verify is not configured yet.");
        return { handled: true, reason: "apply_unconfigured" };
      }
      const news = await listNewDrives(deps.db);
      if (news.length === 0) {
        await deps.telegram.sendMessage(deps.allowedChatId, "No New drives to check.");
        return { handled: true, reason: "apply_none" };
      }
      if (news.length === 1) {
        const verified = await runVerify(deps, news[0]!.id);
        await deps.telegram.sendMessage(deps.allowedChatId, verified.text);
        return { handled: true, reason: verified.reason };
      }
      if (news.length > 8) {
        await deps.telegram.sendMessage(
          deps.allowedChatId,
          "Tap I applied on the drive alert.",
        );
        return { handled: true, reason: "apply_too_many" };
      }
      const choices = news.map((row) => ({
        id: row.id,
        label: driveChoiceLabel(row.company_name, row.event_name),
      }));
      for (const choice of choices) {
        encodeCallback("applied", choice.id);
      }
      await deps.telegram.sendMessage(
        deps.allowedChatId,
        "Which drive?",
        chooseDriveKeyboard(choices),
      );
      return { handled: true, reason: "apply_ask_which" };
    }

    if (SKIP_RE.test(text)) {
      if (!deps.db) {
        await deps.telegram.sendMessage(deps.allowedChatId, "Skip is not configured yet.");
        return { handled: true, reason: "skip_unconfigured" };
      }
      const news = await listNewDrives(deps.db);
      if (news.length === 0) {
        await deps.telegram.sendMessage(deps.allowedChatId, "No New drives to skip.");
        return { handled: true, reason: "skip_none" };
      }
      if (news.length === 1) {
        const skipped = await runSkip(deps, news[0]!.id);
        await deps.telegram.sendMessage(deps.allowedChatId, skipped.text);
        return { handled: true, reason: skipped.reason };
      }
      if (news.length > 8) {
        await deps.telegram.sendMessage(deps.allowedChatId, "Tap Skip on the drive alert.");
        return { handled: true, reason: "skip_too_many" };
      }
      const choices = news.map((row) => ({
        id: row.id,
        label: driveChoiceLabel(row.company_name, row.event_name),
      }));
      for (const choice of choices) {
        encodeCallback("skip", choice.id);
      }
      await deps.telegram.sendMessage(
        deps.allowedChatId,
        "Which drive?",
        chooseSkipDriveKeyboard(choices),
      );
      return { handled: true, reason: "skip_ask_which" };
    }

    return { handled: true, reason: "message_ignored" };
  }

  return { handled: false, reason: "ignored" };
}
