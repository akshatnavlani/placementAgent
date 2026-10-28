import { loadConfig } from "./config.ts";
import { executeCronPoll } from "./poll/executeCronPoll.ts";
import { startPollScheduler } from "./poll/scheduler.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const app = buildServer(config);

const scheduler = startPollScheduler({
  log: {
    info: (obj, msg) => app.log.info(obj, msg),
    warn: (obj, msg) => app.log.warn(obj, msg),
  },
  run: async () => {
    await executeCronPoll({
      config,
      log: {
        info: (obj, msg) => app.log.info(obj, msg),
        warn: (obj, msg) => app.log.warn(obj, msg),
        error: (obj, msg) => app.log.error(obj, msg),
      },
    });
  },
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    scheduler.stop();
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info({ intervalMs: 5 * 60 * 1000 }, "in-process poll scheduler started");
