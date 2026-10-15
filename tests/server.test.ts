import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../app/config.ts";
import { buildServer } from "../app/server.ts";

const secret = "test-cron-secret-0123456789abcdef0123456789";
const app = buildServer(loadConfig({ CRON_SHARED_SECRET: secret, LOG_LEVEL: "silent" }));

afterAll(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("responds without authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, commit: null });
  });
});

describe("POST /cron/poll", () => {
  it("rejects a request with no credentials", async () => {
    const res = await app.inject({ method: "POST", url: "/cron/poll" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/cron/poll",
      headers: { authorization: `Bearer ${secret}x` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects the right secret without the Bearer scheme", async () => {
    const res = await app.inject({ method: "POST", url: "/cron/poll", headers: { authorization: secret } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects before reading a body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/cron/poll",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the shared secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/cron/poll",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true });
  });

  it("is not served over GET", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/cron/poll",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
