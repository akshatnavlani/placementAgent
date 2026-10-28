import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import { requireSupabase } from "./config.ts";
import { createDbClient } from "./db/client.ts";
import { getLatestPendingPayload } from "./db/draft.ts";
import { assertDraftCallbackConfigured, draftCallbackBodySchema, handleDraftCallback } from "./draft/callback.ts";
import { hasBearerSecret } from "./http/bearer.ts";
import { loggerOptions } from "./log.ts";
import { syncRecruitmentMail } from "./mail/sync.ts";
import { executeCronPoll } from "./poll/executeCronPoll.ts";
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
      const result = await executeCronPoll({
        config,
        log: {
          info: (obj, msg) => request.log.info(obj, msg),
          warn: (obj, msg) => request.log.warn(obj, msg),
          error: (obj, msg) => request.log.error(obj, msg),
        },
      });
      if (result.kind === "skipped") {
        return reply.code(202).send({ accepted: true, skipped: true, reason: result.reason });
      }
      return reply.code(202).send({ accepted: true, poll: result.poll });
    },
  );

  app.get(
    "/draft/prepare-payload",
    {
      onRequest: async (request, reply) => {
        let secret: string;
        try {
          secret = assertDraftCallbackConfigured(config);
        } catch {
          return reply.code(503).send({ error: "draft_callback_not_configured" });
        }
        if (!hasBearerSecret(request.headers.authorization, secret)) {
          return reply.code(401).send({ error: "unauthorized" });
        }
      },
    },
    async (request, reply) => {
      const driveId =
        typeof (request.query as { driveId?: unknown }).driveId === "string"
          ? (request.query as { driveId: string }).driveId.trim()
          : "";
      if (!driveId) {
        return reply.code(400).send({ error: "missing_drive_id" });
      }

      let db;
      try {
        const supabase = requireSupabase(config);
        db = createDbClient(supabase.url, supabase.serviceRoleKey);
      } catch {
        return reply.code(503).send({ error: "supabase_not_configured" });
      }

      const payload = await getLatestPendingPayload(db, driveId);
      if (!payload) {
        return reply.code(404).send({ error: "payload_not_found" });
      }
      return reply.code(200).send(payload);
    },
  );

  app.post(
    "/draft/callback",
    {
      onRequest: async (request, reply) => {
        let secret: string;
        try {
          secret = assertDraftCallbackConfigured(config);
        } catch {
          return reply.code(503).send({ error: "draft_callback_not_configured" });
        }
        if (!hasBearerSecret(request.headers.authorization, secret)) {
          return reply.code(401).send({ error: "unauthorized" });
        }
      },
    },
    async (request, reply) => {
      const parsed = draftCallbackBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }

      let db;
      try {
        const supabase = requireSupabase(config);
        db = createDbClient(supabase.url, supabase.serviceRoleKey);
      } catch {
        return reply.code(503).send({ error: "supabase_not_configured" });
      }

      const result = await handleDraftCallback({
        config,
        db,
        body: parsed.data,
        log: {
          info: (obj, msg) => request.log.info(obj, msg),
          warn: (obj, msg) => request.log.warn(obj, msg),
        },
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post(
    "/cron/mail",
    {
      onRequest: async (request, reply) => {
        if (!hasBearerSecret(request.headers.authorization, config.CRON_SHARED_SECRET)) {
          return reply.code(401).send({ error: "unauthorized" });
        }
      },
    },
    async (request, reply) => {
      let db;
      try {
        const supabase = requireSupabase(config);
        db = createDbClient(supabase.url, supabase.serviceRoleKey);
      } catch {
        return reply.code(503).send({ error: "supabase_not_configured" });
      }

      const mail = await syncRecruitmentMail({
        config,
        db,
        log: {
          info: (obj, msg) => request.log.info(obj, msg),
          warn: (obj, msg) => request.log.warn(obj, msg),
        },
      });
      return reply.code(202).send({ accepted: true, mail });
    },
  );

  registerTelegramWebhook(app, config);

  return app;
}
