import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const app = buildServer(config);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
