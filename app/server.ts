import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import { hasTelegram, requireTelegram } from "./config.ts";
import { hasBearerSecret } from "./http/bearer.ts";
import { loggerOptions } from "./log.ts";
import { runPoll } from "./poll/runPoll.ts";
import { TelegramClient } from "./telegram/client.ts";
import { notifyPollOps } from "./telegram/ops.ts";
import { registerTelegramWebhook } from "./telegram/webhook.ts";

export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({ logger: loggerOptions(config.LOG_LEVEL), trustProxy: true });

  app.get("/health", async () => ({
    ok: true,
    commit: config.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
  }));

  app.post(
    "/cron/poll",
    {
      onRequest: async (request, reply) => {
        if (!hasBearerSecret(request.headers.authorization, config.CRON_SHARED_SECRET)) {
          return reply.code(401).send({ error: "unauthorized" });
        }
      },
    },
    async (request, reply) => {
      const poll = await runPoll({
        config,
        log: {
          info: (obj, msg) => request.log.info(obj, msg),
          warn: (obj, msg) => request.log.warn(obj, msg),
          error: (obj, msg) => request.log.error(obj, msg),
        },
      });

      if (hasTelegram(config)) {
        try {
          const tg = requireTelegram(config);
          const telegram = new TelegramClient({
            botToken: tg.botToken,
            fetch: globalThis.fetch.bind(globalThis),
            log: {
              info: (obj, msg) => request.log.info(obj, msg),
              warn: (obj, msg) => request.log.warn(obj, msg),
            },
          });
          await notifyPollOps(
            {
              telegram,
              chatId: tg.chatId,
              log: {
                info: (obj, msg) => request.log.info(obj, msg),
                warn: (obj, msg) => request.log.warn(obj, msg),
              },
            },
            poll,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "ops alert error";
          request.log.warn({ reason: message }, "ops notify skipped");
        }
      }

      return reply.code(202).send({ accepted: true, poll });
    },
  );

  registerTelegramWebhook(app, config);

  return app;
}
