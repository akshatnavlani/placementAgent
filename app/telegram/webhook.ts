import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { requirePlacementCredentials, requireSupabase, requireTelegram } from "../config.ts";
import { createDbClient } from "../db/client.ts";
import { PlacementClient } from "../placement/client.ts";
import { clearBearerToken } from "../db/secret.ts";
import { runPoll } from "../poll/runPoll.ts";
import { TelegramClient } from "./client.ts";
import { handleTelegramUpdate, type TelegramUpdate } from "./handlers.ts";

function secretEquals(given: string | undefined, expected: string): boolean {
  if (!given) {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function registerTelegramWebhook(app: FastifyInstance, config: Config): void {
  app.post("/telegram/webhook", async (request: FastifyRequest, reply: FastifyReply) => {
    let telegramConfig;
    try {
      telegramConfig = requireTelegram(config);
    } catch {
      return reply.code(503).send({ error: "telegram_not_configured" });
    }

    const header = request.headers["x-telegram-bot-api-secret-token"];
    const headerValue = Array.isArray(header) ? header[0] : header;
    if (!secretEquals(headerValue, telegramConfig.webhookSecret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const update = request.body as TelegramUpdate;
    const client = new TelegramClient({
      botToken: telegramConfig.botToken,
      log: {
        info: (obj, msg) => request.log.info(obj, msg),
        warn: (obj, msg) => request.log.warn(obj, msg),
      },
    });

    let db;
    let placement;
    try {
      const supabase = requireSupabase(config);
      requirePlacementCredentials(config);
      db = createDbClient(supabase.url, supabase.serviceRoleKey);
      placement = new PlacementClient({
        log: {
          info: (obj, msg) => request.log.info(obj, msg),
          warn: (obj, msg) => request.log.warn(obj, msg),
        },
        onUnauthorized: async () => {
          await clearBearerToken(db!);
        },
      });
    } catch {
      db = undefined;
      placement = undefined;
    }

    await handleTelegramUpdate(
      {
        telegram: client,
        allowedChatId: telegramConfig.chatId,
        config,
        db,
        placement,
        log: {
          info: (obj, msg) => request.log.info(obj, msg),
          warn: (obj, msg) => request.log.warn(obj, msg),
        },
        onSessionRestored: async () => {
          await runPoll({
            config,
            log: {
              info: (obj, msg) => request.log.info(obj, msg),
              warn: (obj, msg) => request.log.warn(obj, msg),
              error: (obj, msg) => request.log.error(obj, msg),
            },
            db,
            placement,
            telegram: client,
          });
        },
      },
      update ?? {},
    );

    // Always 200 to Telegram once the secret matches.
    return reply.code(200).send({ ok: true });
  });
}
