import type { GmailClient } from "./client.ts";

export const OTP_CODE_RE = /\b(\d{4,8})\b/;

export type FindOtpOptions = {
  gmail: GmailClient;
  /** Lower bound for message internalDate (ms). */
  afterMs: number;
  log?: { info: (obj: Record<string, unknown>, msg?: string) => void; warn: (obj: Record<string, unknown>, msg?: string) => void };
};

/**
 * Search PESU inbox for an OTP mailed after `afterMs`.
 * Returns the code to the caller only — never logs the digits.
 */
export async function findOtpInPesuMail(
  options: FindOtpOptions,
): Promise<{ found: true; code: string; messageId: string } | { found: false; reason: string }> {
  const afterUnix = Math.floor(Math.max(0, options.afterMs - 5_000) / 1000);
  const listed = await options.gmail.listMessageIds(`after:${afterUnix}`, 15);
  if (!listed.ok) {
    options.log?.warn({ outcome: "list_failed" }, "otp mail search");
    return { found: false, reason: listed.reason };
  }

  for (const id of listed.ids) {
    const meta = await options.gmail.getMessageMeta(id);
    if (!meta.ok) {
      continue;
    }
    if (meta.meta.internalDateMs < options.afterMs - 5_000) {
      continue;
    }
    const haystack = `${meta.meta.subject}\n${meta.meta.snippet}`;
    const match = OTP_CODE_RE.exec(haystack);
    if (match?.[1]) {
      options.log?.info({ messageId: id, matched: true }, "otp mail search");
      return { found: true, code: match[1], messageId: id };
    }
    options.log?.info({ messageId: id, matched: false }, "otp mail search");
  }

  return { found: false, reason: "no_match" };
}

export async function pollOtpInPesuMail(
  options: FindOtpOptions & {
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ found: true; code: string; messageId: string } | { found: false; reason: string }> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 15_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await findOtpInPesuMail(options);
    if (result.found) {
      return result;
    }
    if (result.reason !== "no_match") {
      // Transient API failure: keep trying until timeout.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(intervalMs, remaining));
  }
  return { found: false, reason: "timeout" };
}
