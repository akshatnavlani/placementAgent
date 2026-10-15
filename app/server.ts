import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import { hasBearerSecret } from "./http/bearer.ts";
import { loggerOptions } from "./log.ts";

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
    async (_request, reply) => reply.code(202).send({ accepted: true, poll: "stub" }),
  );

  return app;
}
