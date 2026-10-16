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

  it("keeps placement and supabase credentials optional for /health boot", () => {
    const config = loadConfig({ CRON_SHARED_SECRET: secret });
    expect(config.PLACEMENT_PASSWORD).toBeUndefined();
    expect(config.SUPABASE_URL).toBeUndefined();
  });

  it("loads optional M1 credentials when present and trims blanks", () => {
    const config = loadConfig({
      CRON_SHARED_SECRET: secret,
      PLACEMENT_STUDENT_ID: " PES1UG00XX000 ",
      PLACEMENT_PASSWORD: " hunter2 ",
      SUPABASE_URL: " https://example.supabase.co ",
      SUPABASE_SERVICE_ROLE_KEY: " sb_secret_test ",
    });
    expect(config.PLACEMENT_STUDENT_ID).toBe("PES1UG00XX000");
    expect(config.PLACEMENT_PASSWORD).toBe("hunter2");
    expect(config.SUPABASE_URL).toBe("https://example.supabase.co");
    expect(config.SUPABASE_SERVICE_ROLE_KEY).toBe("sb_secret_test");
  });

  it("does not echo secret values in validation errors", () => {
    const weak = "short-secret-value";
    let message = "";
    try {
      loadConfig({ CRON_SHARED_SECRET: weak, PLACEMENT_PASSWORD: "hunter2" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain(weak);
  });
});
