import type { Config } from "../config.ts";
import { hasGmailPesu, hasTelegram, requireGmailPesu, requirePlacementCredentials, requireTelegram } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { upsertPlatformProfile } from "../db/profile.ts";
import {
  clearLoginWait,
  loadAuthState,
  markOtpPastePrompted,
  markOtpSent,
  upsertBearerToken,
} from "../db/secret.ts";
import { GmailClient } from "../gmail/client.ts";
import { pollOtpInPesuMail } from "../gmail/otpMail.ts";
import type { PlacementClient } from "../placement/client.ts";
import type { TelegramClient } from "../telegram/client.ts";

export type OtpLogger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
};

export type OtpFlowResult =
  | { kind: "restored" }
  | { kind: "need_paste" }
  | { kind: "wrong_state"; state: string | null }
  | { kind: "failed"; reason: string };

export type OtpDeps = {
  config: Config;
  db: DbClient;
  placement: PlacementClient;
  telegram?: TelegramClient;
  gmail?: GmailClient;
  log?: OtpLogger;
  now?: Date;
  /** Test seams for Gmail polling. */
  otpTimeoutMs?: number;
  otpIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

async function storeVerified(
  deps: OtpDeps,
  studentId: string,
  token: string,
  profile: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await upsertBearerToken(deps.db, token, "verifyOtp", now);
  await upsertPlatformProfile(deps.db, studentId, profile, now);
  await clearLoginWait(deps.db);
}

async function notifyRestored(deps: OtpDeps): Promise<void> {
  if (hasTelegram(deps.config) && deps.telegram) {
    const tg = requireTelegram(deps.config);
    await deps.telegram.sendMessage(tg.chatId, "Session restored.");
  }
}

async function promptPaste(deps: OtpDeps): Promise<void> {
  const state = await loadAuthState(deps.db);
  if (state.otpPastePromptedAt) {
    return;
  }
  await markOtpPastePrompted(deps.db, deps.now ?? new Date());
  if (hasTelegram(deps.config) && deps.telegram) {
    const tg = requireTelegram(deps.config);
    await deps.telegram.sendMessage(tg.chatId, "Paste the OTP from your PESU email.");
  }
}

/**
 * Approve handler: password check; if token returned skip OTP; else sendOtp and try Gmail / paste.
 */
export async function beginOtpAfterApprove(deps: OtpDeps): Promise<OtpFlowResult> {
  const now = deps.now ?? new Date();
  const state = await loadAuthState(deps.db);
  if (state.loginWaitState !== "awaiting_approval" && state.loginWaitState !== "awaiting_otp") {
    // Allow Approve only from waiting states.
    if (state.loginWaitState !== null) {
      return { kind: "wrong_state", state: state.loginWaitState };
    }
    // If somehow idle but user taps Approve, still try password renew.
  }

  const creds = requirePlacementCredentials(deps.config);
  const login = await deps.placement.validateStudent(creds.studentId, creds.password);
  if (login.kind === "ok") {
    await upsertBearerToken(deps.db, login.data.token, "validatestudent", now);
    await upsertPlatformProfile(deps.db, creds.studentId, login.data.profile, now);
    await clearLoginWait(deps.db);
    await notifyRestored(deps);
    return { kind: "restored" };
  }
  if (login.kind !== "noToken") {
    const reason = login.kind === "network" ? login.message : login.kind;
    return { kind: "failed", reason: String(reason) };
  }

  const sent = await deps.placement.sendOtp(creds.studentId);
  if (sent.kind !== "ok") {
    const reason = sent.kind === "network" ? sent.message : sent.kind;
    return { kind: "failed", reason: `sendOtp:${reason}` };
  }

  const sentAt = now;
  await markOtpSent(deps.db, sentAt);

  if (hasGmailPesu(deps.config) || deps.gmail) {
    const gmail =
      deps.gmail ??
      (() => {
        const g = requireGmailPesu(deps.config);
        return new GmailClient({
          clientId: g.clientId,
          clientSecret: g.clientSecret,
          refreshToken: g.refreshToken,
          log: deps.log,
        });
      })();

    const found = await pollOtpInPesuMail({
      gmail,
      afterMs: sentAt.getTime(),
      log: deps.log,
      timeoutMs: deps.otpTimeoutMs,
      intervalMs: deps.otpIntervalMs,
      sleep: deps.sleep,
    });
    if (found.found) {
      return completeOtp(deps, found.code);
    }
  }

  await promptPaste(deps);
  return { kind: "need_paste" };
}

/** Complete OTP from Gmail or Telegram paste. Never log `code`. */
export async function completeOtp(deps: OtpDeps, code: string): Promise<OtpFlowResult> {
  const now = deps.now ?? new Date();
  const state = await loadAuthState(deps.db);
  if (state.loginWaitState !== "awaiting_otp") {
    return { kind: "wrong_state", state: state.loginWaitState };
  }

  const trimmed = code.trim();
  if (!/^\d{4,8}$/.test(trimmed)) {
    return { kind: "failed", reason: "invalid_otp_format" };
  }

  const creds = requirePlacementCredentials(deps.config);
  const verified = await deps.placement.verifyOtp(creds.studentId, trimmed);
  if (verified.kind === "ok") {
    await storeVerified(deps, creds.studentId, verified.data.token, verified.data.profile, now);
    await notifyRestored(deps);
    deps.log?.info({ outcome: "verify_ok" }, "otp verified");
    return { kind: "restored" };
  }
  if (verified.kind === "noToken") {
    deps.log?.warn({ outcome: "verify_no_token" }, "otp verify returned no token");
    return { kind: "failed", reason: "verify_no_token" };
  }
  const reason = verified.kind === "network" ? verified.message : verified.kind;
  deps.log?.warn({ outcome: "verify_failed", reason }, "otp verify failed");
  return { kind: "failed", reason: String(reason) };
}
