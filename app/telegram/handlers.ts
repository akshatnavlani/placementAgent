import { skipDrive, skipReplyText } from "../apply/skip.ts";
import { submitApplication, submitReplyText } from "../apply/submit.ts";
import { beginOtpAfterApprove, completeOtp, type OtpDeps } from "../auth/otp.ts";
import type { Config } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { listNewDrives } from "../db/drive.ts";
import { getMailById } from "../db/mail.ts";
import { loadFullProfile, loadPlatformProfile } from "../db/profile.ts";
import { getPollReportsEnabled, loadAuthState, setPollReportsEnabled } from "../db/secret.ts";
import {
  handlePrepareAskChoice,
  handlePrepareAskText,
  isPrepareAskActive,
  startPrepareAsk,
} from "../draft/askMissing.ts";
import { prepareDrive, prepareReplyText } from "../draft/prepare.ts";
import { bindMailAndApply } from "../mail/applyClassification.ts";
import { classifyRecruitmentMail, nameTokensFromProfile } from "../mail/classify.ts";
import type { PlacementClient } from "../placement/client.ts";
import { runPoll, type PollSummary } from "../poll/runPoll.ts";
import {
  chooseDriveKeyboard,
  chooseSkipDriveKeyboard,
  decodeCallback,
  encodeCallback,
} from "./buttons.ts";
import type { TelegramClient } from "./client.ts";
import {
  handleGithubCallback,
  handleLatexDocument,
  handleOnboardingText,
  handleProfileCallback,
  isProfileCommand,
  showProfileMenu,
  startLatexOnly,
  startWizard,
} from "./onboarding.ts";

export type TelegramUpdate = {
  update_id?: number;
  message?: {
    chat?: { id?: number | string };
    text?: string;
    document?: {
      file_id?: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
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
  /** Test seam / override for /poll. Defaults to runPoll with handler deps. */
  runManualPoll?: () => Promise<PollSummary>;
  log?: OtpDeps["log"];
  fetch?: typeof globalThis.fetch;
};

/** `/poll` or `poll` (optional @bot suffix). */
export function isPollCommand(text: string): boolean {
  return /^\/?poll(?:@\w+)?\s*$/i.test(text.trim());
}

/** `/pollreports` [on|off] */
export function parsePollReportsCommand(
  text: string,
): { kind: "status" } | { kind: "set"; enabled: boolean } | null {
  const t = text.trim();
  if (/^\/?pollreports(?:@\w+)?\s+on\s*$/i.test(t)) {
    return { kind: "set", enabled: true };
  }
  if (/^\/?pollreports(?:@\w+)?\s+off\s*$/i.test(t)) {
    return { kind: "set", enabled: false };
  }
  if (/^\/?pollreports(?:@\w+)?\s*$/i.test(t)) {
    return { kind: "status" };
  }
  return null;
}

export function formatPollReply(poll: PollSummary): string {
  if (!poll.ok) {
    return `Poll failed: ${poll.alert ?? "unknown"}`;
  }
  const lines = [
    "Poll done.",
    `New: ${poll.inserted} · Updated: ${poll.refreshed} · Touched: ${poll.touched}`,
    `Notified: ${poll.notified} · Details: ${poll.detailsFetched} · PDFs: ${poll.pdfsFetched}`,
  ];
  if (poll.reminded || poll.applyChecked || poll.markedApplied || poll.notApplied) {
    lines.push(
      `Reminders: ${poll.reminded} · Apply checks: ${poll.applyChecked} · Marked applied: ${poll.markedApplied} · Not applied: ${poll.notApplied}`,
    );
  }
  if (poll.alerts.length > 0) {
    lines.push(`Alerts: ${poll.alerts.slice(0, 5).join(", ")}`);
  }
  return lines.join("\n");
}

const I_APPLIED_RE = /^\s*(?:i\s*applied|apply)\s*[.!?]?\s*$/i;
const SKIP_DRIVE_RE = /^\s*(won'?t\s+apply|wont\s+apply)\s*[.!?]?\s*$/i;
/** Bare "skip" is reserved for onboarding field-skip when a wizard is active. */
const SKIP_DRIVE_BARE_RE = /^\s*skip\s*[.!?]?\s*$/i;

function driveChoiceLabel(company: string | null, eventName: string | null): string {
  const companyPart = company?.trim() || "Unknown";
  const rolePart = eventName?.trim();
  if (rolePart) {
    return `${companyPart} — ${rolePart}`.slice(0, 40);
  }
  return companyPart.slice(0, 40);
}

function onboardingDeps(deps: HandleUpdateDeps) {
  return {
    db: deps.db!,
    telegram: deps.telegram,
    chatId: deps.allowedChatId,
    fetch: deps.fetch,
    log: deps.log,
  };
}

async function runApply(
  deps: HandleUpdateDeps,
  driveId: string,
): Promise<{ text: string; reason: string }> {
  if (!deps.config || !deps.db || !deps.placement) {
    return { text: "Apply is not configured yet.", reason: "apply_unconfigured" };
  }
  const result = await submitApplication(
    {
      config: deps.config,
      db: deps.db,
      placement: deps.placement,
      telegram: deps.telegram,
      chatId: deps.allowedChatId,
      log: deps.log,
      fetch: deps.fetch,
    },
    driveId,
  );
  return { text: submitReplyText(result), reason: `apply_${result.kind}` };
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

async function isOnboardingActive(deps: HandleUpdateDeps): Promise<boolean> {
  if (!deps.db) {
    return false;
  }
  const profile = await loadFullProfile(deps.db);
  if (!profile) {
    return false;
  }
  if (isPrepareAskActive(profile.onboarding)) {
    return true;
  }
  return Boolean(profile.onboarding.step) && profile.onboarding.mode !== "prepare_ask";
}

async function runPrepare(
  deps: HandleUpdateDeps,
  driveId: string,
  opts?: { skipAskGate?: boolean },
): Promise<{ text: string; reason: string }> {
  if (!deps.config || !deps.db) {
    return { text: "Drafter not configured.", reason: "prepare_unconfigured" };
  }
  const result = await prepareDrive(
    {
      config: deps.config,
      db: deps.db,
      telegram: deps.telegram,
      chatId: deps.allowedChatId,
      fetch: deps.fetch,
      log: deps.log,
      skipAskGate: opts?.skipAskGate,
    },
    driveId,
  );
  if (result.kind === "need_answers") {
    await startPrepareAsk(
      {
        db: deps.db,
        telegram: deps.telegram,
        chatId: deps.allowedChatId,
        log: deps.log,
      },
      result.driveId,
      result.fields,
    );
    return { text: prepareReplyText(result), reason: "prepare_need_answers" };
  }
  return { text: prepareReplyText(result), reason: `prepare_${result.kind}` };
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
    if (decoded.kind === "profile") {
      await deps.telegram.answerCallbackQuery(callback.id, "OK");
      if (!deps.db) {
        await deps.telegram.sendMessage(deps.allowedChatId, "Profile is not configured yet.");
        return { handled: true, reason: "profile_unconfigured" };
      }
      await handleProfileCallback(onboardingDeps(deps), decoded.action);
      return { handled: true, reason: `profile_${decoded.action}` };
    }
    if (decoded.kind === "github") {
      await deps.telegram.answerCallbackQuery(callback.id, "OK");
      if (!deps.db) {
        return { handled: true, reason: "profile_unconfigured" };
      }
      await handleGithubCallback(onboardingDeps(deps), decoded.action, decoded.index);
      return { handled: true, reason: `github_${decoded.action}` };
    }
    if (decoded.kind === "ask") {
      await deps.telegram.answerCallbackQuery(callback.id, "OK");
      if (!deps.db || !deps.config) {
        return { handled: true, reason: "prepare_unconfigured" };
      }
      const ask = await handlePrepareAskChoice(
        {
          db: deps.db,
          telegram: deps.telegram,
          chatId: deps.allowedChatId,
          log: deps.log,
        },
        decoded.optionIndex,
      );
      if (ask.kind === "complete") {
        const prepared = await runPrepare(deps, ask.driveId, { skipAskGate: true });
        await deps.telegram.sendMessage(deps.allowedChatId, prepared.text);
        return { handled: true, reason: prepared.reason };
      }
      return { handled: true, reason: `ask_${ask.kind}` };
    }
    if (decoded.kind === "mail") {
      await deps.telegram.answerCallbackQuery(callback.id, "Binding…");
      if (!deps.db || !deps.config) {
        await deps.telegram.sendMessage(deps.allowedChatId, "Mail bind is not configured yet.");
        return { handled: true, reason: "mail_unconfigured" };
      }
      const mail = await getMailById(deps.db, decoded.mailId);
      if (!mail) {
        await deps.telegram.sendMessage(deps.allowedChatId, "That mail row is gone.");
        return { handled: true, reason: "mail_missing" };
      }
      const profile = await loadPlatformProfile(deps.db);
      const tokens = profile ? nameTokensFromProfile(profile.platform) : [];
      const classified = classifyRecruitmentMail({
        subject: mail.subject,
        snippet: mail.snippet,
        bodyText: typeof mail.raw_meta.bodyText === "string" ? mail.raw_meta.bodyText : mail.snippet,
        studentNameTokens: tokens,
      });
      // Prefer stored classification from when we asked
      const result = await bindMailAndApply(
        {
          config: deps.config,
          db: deps.db,
          telegram: deps.telegram,
          chatId: deps.allowedChatId,
          fetch: deps.fetch,
          log: deps.log,
        },
        { ...mail, classification: mail.classification },
        decoded.driveId,
        {
          ...classified,
          classification: mail.classification,
          confidence: mail.confidence,
          reason: classified.reason || mail.classification,
        },
      );
      return { handled: true, reason: result.asked ? "mail_ask" : `mail_${result.reason}` };
    }
    if (decoded.kind === "prepare") {
      await deps.telegram.answerCallbackQuery(callback.id, "Preparing…");
      const prepared = await runPrepare(deps, decoded.driveId);
      await deps.telegram.sendMessage(deps.allowedChatId, prepared.text);
      return { handled: true, reason: prepared.reason };
    }
    if (decoded.kind === "skip") {
      await deps.telegram.answerCallbackQuery(callback.id, "Skipping…");
      const skipped = await runSkip(deps, decoded.driveId);
      await deps.telegram.sendMessage(deps.allowedChatId, skipped.text);
      return { handled: true, reason: skipped.reason };
    }
    // applied / Apply
    await deps.telegram.answerCallbackQuery(callback.id, "Applying…");
    const applied = await runApply(deps, decoded.driveId);
    await deps.telegram.sendMessage(deps.allowedChatId, applied.text);
    return { handled: true, reason: applied.reason };
  }

  const message = update.message;
  if (message) {
    const chatId = String(message.chat?.id ?? "");
    if (chatId !== deps.allowedChatId) {
      return { handled: false, reason: "wrong_chat" };
    }

    if (message.document?.file_id && deps.db) {
      const name = (message.document.file_name ?? "").toLowerCase();
      const mime = (message.document.mime_type ?? "").toLowerCase();
      const looksTex =
        name.endsWith(".tex") || mime.includes("tex") || mime === "application/x-tex" || mime === "text/x-tex";
      if (looksTex) {
        const file = await deps.telegram.getFile(message.document.file_id);
        if (!file.ok) {
          await deps.telegram.sendMessage(deps.allowedChatId, "Could not download that file.");
          return { handled: true, reason: "latex_download_failed" };
        }
        const downloaded = await deps.telegram.downloadFile(file.filePath);
        if (!downloaded.ok) {
          await deps.telegram.sendMessage(deps.allowedChatId, "Could not download that file.");
          return { handled: true, reason: "latex_download_failed" };
        }
        const latex = new TextDecoder().decode(downloaded.bytes);
        const handled = await handleLatexDocument(onboardingDeps(deps), latex);
        if (handled) {
          return { handled: true, reason: "profile_latex_doc" };
        }
      } else if (name.endsWith(".pdf") || mime.includes("pdf")) {
        if (await isOnboardingActive(deps)) {
          await deps.telegram.sendMessage(
            deps.allowedChatId,
            "PDF is not accepted as canonical. Send a .tex file or paste LaTeX.",
          );
          return { handled: true, reason: "profile_pdf_rejected" };
        }
      }
    }

    const text = (message.text ?? "").trim();
    if (!text) {
      return { handled: true, reason: "message_ignored" };
    }

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

    // prepare_ask consumes text before profile wizard / apply phrases.
    if (deps.db && deps.config) {
      const profile = await loadFullProfile(deps.db);
      if (isPrepareAskActive(profile?.onboarding)) {
        const ask = await handlePrepareAskText(
          {
            db: deps.db,
            telegram: deps.telegram,
            chatId: deps.allowedChatId,
            log: deps.log,
          },
          text,
        );
        if (ask.kind === "complete") {
          const prepared = await runPrepare(deps, ask.driveId, { skipAskGate: true });
          await deps.telegram.sendMessage(deps.allowedChatId, prepared.text);
          return { handled: true, reason: prepared.reason };
        }
        if (ask.kind !== "ignored") {
          return { handled: true, reason: `ask_${ask.kind}` };
        }
      }
    }

    // Active onboarding consumes text (including bare "skip").
    if (deps.db && (await isOnboardingActive(deps))) {
      const consumed = await handleOnboardingText(onboardingDeps(deps), text);
      if (consumed) {
        return { handled: true, reason: "onboarding" };
      }
    }

    const profileCmd = isProfileCommand(text);
    if (profileCmd) {
      if (!deps.db) {
        await deps.telegram.sendMessage(deps.allowedChatId, "Profile is not configured yet.");
        return { handled: true, reason: "profile_unconfigured" };
      }
      if (profileCmd.kind === "redo") {
        await startWizard(onboardingDeps(deps), "redo");
        return { handled: true, reason: "profile_redo" };
      }
      if (profileCmd.kind === "latex") {
        await startLatexOnly(onboardingDeps(deps));
        return { handled: true, reason: "profile_latex" };
      }
      await showProfileMenu(onboardingDeps(deps));
      return { handled: true, reason: "profile_menu" };
    }

    const pollReportsCmd = parsePollReportsCommand(text);
    if (pollReportsCmd) {
      if (!deps.db) {
        await deps.telegram.sendMessage(deps.allowedChatId, "Poll reports not configured yet.");
        return { handled: true, reason: "pollreports_unconfigured" };
      }
      if (pollReportsCmd.kind === "set") {
        await setPollReportsEnabled(deps.db, pollReportsCmd.enabled);
        await deps.telegram.sendMessage(
          deps.allowedChatId,
          pollReportsCmd.enabled
            ? "Poll reports on — cron summaries will be sent here."
            : "Poll reports off — cron summaries paused. Manual /poll still replies.",
        );
        return { handled: true, reason: pollReportsCmd.enabled ? "pollreports_on" : "pollreports_off" };
      }
      const on = await getPollReportsEnabled(deps.db);
      await deps.telegram.sendMessage(
        deps.allowedChatId,
        on
          ? "Poll reports are on. Send /pollreports off to pause."
          : "Poll reports are off. Send /pollreports on to resume.",
      );
      return { handled: true, reason: "pollreports_status" };
    }

    if (isPollCommand(text)) {
      if (!deps.config || (!deps.runManualPoll && (!deps.db || !deps.placement))) {
        await deps.telegram.sendMessage(deps.allowedChatId, "Poll is not configured yet.");
        return { handled: true, reason: "poll_unconfigured" };
      }
      await deps.telegram.sendMessage(deps.allowedChatId, "Polling…");
      const poll = deps.runManualPoll
        ? await deps.runManualPoll()
        : await runPoll({
            config: deps.config,
            db: deps.db,
            placement: deps.placement,
            telegram: deps.telegram,
            log: deps.log,
            fetch: deps.fetch,
          });
      await deps.telegram.sendMessage(deps.allowedChatId, formatPollReply(poll));
      return { handled: true, reason: poll.ok ? "poll_ok" : "poll_failed" };
    }

    if (I_APPLIED_RE.test(text)) {
      if (!deps.db) {
        await deps.telegram.sendMessage(deps.allowedChatId, "Apply is not configured yet.");
        return { handled: true, reason: "apply_unconfigured" };
      }
      const news = await listNewDrives(deps.db);
      if (news.length === 0) {
        await deps.telegram.sendMessage(deps.allowedChatId, "No New drives to apply to.");
        return { handled: true, reason: "apply_none" };
      }
      if (news.length === 1) {
        const applied = await runApply(deps, news[0]!.id);
        await deps.telegram.sendMessage(deps.allowedChatId, applied.text);
        return { handled: true, reason: applied.reason };
      }
      if (news.length > 8) {
        await deps.telegram.sendMessage(
          deps.allowedChatId,
          "Tap Apply on the drive alert.",
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

    const isDriveSkip = SKIP_DRIVE_RE.test(text) || SKIP_DRIVE_BARE_RE.test(text);
    if (isDriveSkip) {
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
