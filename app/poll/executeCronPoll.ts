import type { Config } from "../config.ts";
import { hasTelegram, requireSupabase, requireTelegram } from "../config.ts";
import { createDbClient } from "../db/client.ts";
import { getPollReportsEnabled, setLastCronAt } from "../db/secret.ts";
import { formatPollReply } from "../telegram/handlers.ts";
import { TelegramClient } from "../telegram/client.ts";
import { notifyPollOps } from "../telegram/ops.ts";
import { runPoll, type PollSummary } from "./runPoll.ts";

let pollInFlight = false;

export function isPollInFlight(): boolean {
  return pollInFlight;
}

export type ExecuteCronPollResult =
  | { kind: "ok"; poll: PollSummary }
  | { kind: "skipped"; reason: "in_flight" };

/**
 * One scheduled/cron poll: stamp last_cron_at at fire, run poll, optional Telegram report.
 * Skips if another poll is already running (overlap guard).
 */
export async function executeCronPoll(input: {
  config: Config;
  log?: {
    info: (obj: Record<string, unknown>, msg?: string) => void;
    warn: (obj: Record<string, unknown>, msg?: string) => void;
    error?: (obj: Record<string, unknown>, msg?: string) => void;
  };
  /** Stamp time (defaults to now). */
  firedAt?: Date;
}): Promise<ExecuteCronPollResult> {
  if (pollInFlight) {
    input.log?.warn?.({}, "poll skipped; already in flight");
    return { kind: "skipped", reason: "in_flight" };
  }

  pollInFlight = true;
  const firedAt = input.firedAt ?? new Date();
  try {
    try {
      const supabase = requireSupabase(input.config);
      const db = createDbClient(supabase.url, supabase.serviceRoleKey);
      await setLastCronAt(db, firedAt);
    } catch (stampErr) {
      const reason = stampErr instanceof Error ? stampErr.message : "stamp failed";
      input.log?.warn?.({ reason }, "last_cron_at stamp skipped");
    }

    const poll = await runPoll({
      config: input.config,
      log: input.log,
    });

    if (hasTelegram(input.config)) {
      try {
        const tg = requireTelegram(input.config);
        const telegram = new TelegramClient({
          botToken: tg.botToken,
          fetch: globalThis.fetch.bind(globalThis),
          log: input.log
            ? {
                info: input.log.info,
                warn: input.log.warn,
              }
            : undefined,
        });
        await notifyPollOps(
          {
            telegram,
            chatId: tg.chatId,
            log: input.log
              ? {
                  info: input.log.info,
                  warn: input.log.warn,
                }
              : undefined,
          },
          poll,
        );

        let reportsOn = true;
        try {
          const supabase = requireSupabase(input.config);
          const db = createDbClient(supabase.url, supabase.serviceRoleKey);
          reportsOn = await getPollReportsEnabled(db);
        } catch {
          reportsOn = true;
        }
        if (reportsOn) {
          const sent = await telegram.sendMessage(tg.chatId, formatPollReply(poll));
          if (!sent.ok) {
            input.log?.warn?.({ reason: sent.reason }, "poll report skipped");
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "ops alert error";
        input.log?.warn?.({ reason: message }, "ops notify skipped");
      }
    }

    return { kind: "ok", poll };
  } finally {
    pollInFlight = false;
  }
}

/** Test seam. */
export function resetPollInFlightForTests(): void {
  pollInFlight = false;
}
