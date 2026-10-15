import { describe, expect, it } from "vitest";
import { loadConfig } from "../app/config.ts";

const secret = "test-cron-secret-0123456789abcdef0123456789";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({ CRON_SHARED_SECRET: secret });
    expect(config).toMatchObject({ HOST: "0.0.0.0", PORT: 10000, LOG_LEVEL: "info" });
  });

  it("treats blank values as unset", () => {
    const config = loadConfig({ CRON_SHARED_SECRET: secret, PORT: "", LOG_LEVEL: "" });
    expect(config.PORT).toBe(10000);
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("refuses to start without a cron secret", () => {
    expect(() => loadConfig({})).toThrow(/CRON_SHARED_SECRET/);
  });

  it("refuses a short cron secret without echoing it", () => {
    const weak = "short-secret-value";
    let message = "";
    try {
      loadConfig({ CRON_SHARED_SECRET: weak });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/CRON_SHARED_SECRET/);
    expect(message).not.toContain(weak);
  });

  it("does not expose unrelated environment variables", () => {
    const config = loadConfig({ CRON_SHARED_SECRET: secret, PLACEMENT_PASSWORD: "hunter2" });
    expect(Object.keys(config)).not.toContain("PLACEMENT_PASSWORD");
  });
});
