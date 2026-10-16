import type { Config } from "../config.ts";
import { hasTelegram, requirePlacementCredentials, requireTelegram } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { upsertPlatformProfile } from "../db/profile.ts";
import {
  clearLoginWait,
  loadAuthState,
  setLoginWait,
  upsertBearerToken,
} from "../db/secret.ts";
import type { PlacementClient } from "../placement/client.ts";
import type { TelegramClient } from "../telegram/client.ts";
import { approveKeyboard } from "../telegram/buttons.ts";

export type RenewLogger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
};

export type RenewResult =
  | { kind: "renewed" }
  | { kind: "waiting" }
  | { kind: "awaiting_otp" }
  | { kind: "failed"; reason: string };

export type RenewDeps = {
  config: Config;
  db: DbClient;
  placement: PlacementClient;
  telegram?: TelegramClient;
  log?: RenewLogger;
  now?: Date;
};

/**
 * Password-first renewal after a placement 401 / missing bearer.
 * Does not spam Telegram while already waiting for approval or OTP.
 */
export async function renewFromUnauthorized(deps: RenewDeps): Promise<RenewResult> {
  const now = deps.now ?? new Date();
  const state = await loadAuthState(deps.db);

  if (state.loginWaitState === "awaiting_otp") {
    deps.log?.info({ alert: "awaiting_otp" }, "renew skipped; waiting for OTP");
    return { kind: "awaiting_otp" };
  }

  const creds = requirePlacementCredentials(deps.config);
  const login = await deps.placement.validateStudent(creds.studentId, creds.password);

  if (login.kind === "ok") {
    await upsertBearerToken(deps.db, login.data.token, "validatestudent", now);
    await upsertPlatformProfile(deps.db, creds.studentId, login.data.profile, now);
    await clearLoginWait(deps.db);
    if (hasTelegram(deps.config) && deps.telegram) {
      const tg = requireTelegram(deps.config);
      await deps.telegram.sendMessage(tg.chatId, "Session renewed.");
    }
    deps.log?.info({ outcome: "renewed" }, "session renewed via password");
    return { kind: "renewed" };
  }

  if (login.kind === "noToken") {
    const alreadyNotified = Boolean(state.loginWaitNotifiedAt) && state.loginWaitState === "awaiting_approval";
    if (!alreadyNotified) {
      await setLoginWait(deps.db, "awaiting_approval", { notifiedAt: now });
      if (hasTelegram(deps.config) && deps.telegram) {
        const tg = requireTelegram(deps.config);
        await deps.telegram.sendMessage(
          tg.chatId,
          "Logged out, waiting for approval.",
          approveKeyboard(),
        );
      }
    } else {
      await setLoginWait(deps.db, "awaiting_approval");
    }
    deps.log?.info({ outcome: "waiting", notified: !alreadyNotified }, "awaiting login approval");
    return { kind: "waiting" };
  }

  const reason = login.kind === "network" ? login.message : login.kind;
  deps.log?.warn({ outcome: "failed", reason }, "validateStudent failed during renew");
  return { kind: "failed", reason: String(reason) };
}
