import type { TelegramClient } from "./client.ts";

/** Process-lifetime dedup for ops alerts. */
const sentKeys = new Set<string>();

/** Test seam. */
export function resetOpsAlertKeys(): void {
  sentKeys.clear();
}

export type OpsAlertDeps = {
  telegram: TelegramClient;
  chatId: string;
  log?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
};

/**
 * Send an ops Telegram once per process for a given key.
 * Returns whether a message was sent.
 */
export async function sendOpsAlertOnce(
  deps: OpsAlertDeps,
  key: string,
  text: string,
): Promise<boolean> {
  if (sentKeys.has(key)) {
    return false;
  }
  sentKeys.add(key);
  const sent = await deps.telegram.sendMessage(deps.chatId, text);
  if (!sent.ok) {
    deps.log?.warn?.({ key, reason: sent.reason }, "ops telegram failed");
    // Allow retry on next failure.
    sentKeys.delete(key);
    return false;
  }
  deps.log?.info?.({ key }, "ops telegram sent");
  return true;
}

const LOGIN_WAIT_ALERTS = new Set(["awaiting_login_approval", "awaiting_otp"]);

/**
 * After a poll: notify on hard failure (not login-wait) and on rate limit.
 */
export async function notifyPollOps(
  deps: OpsAlertDeps,
  poll: { ok: boolean; alert?: string; alerts: string[] },
): Promise<void> {
  if (!poll.ok && poll.alert && !LOGIN_WAIT_ALERTS.has(poll.alert)) {
    await sendOpsAlertOnce(deps, `poll_fail:${poll.alert}`, `Poll failed: ${poll.alert}`);
  }

  const rateLimited =
    poll.alert === "rateLimited" ||
    poll.alerts.some((a) => a === "rateLimited" || a.includes(":rateLimited"));
  if (rateLimited) {
    await sendOpsAlertOnce(
      deps,
      "placement_rate_limited",
      "Placement rate-limited; backing off",
    );
  }
}
