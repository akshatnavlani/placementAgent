import { describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.ts";
import { buildServer } from "../app/server.ts";
import * as dbClient from "../app/db/client.ts";
import type { PreparePayload } from "../app/draft/payload.ts";

const secret = "draft-callback-secret-0123456789abcdef0123";

const payload: PreparePayload = {
  driveId: "drive-1",
  company: "Acme",
  role: "SDE",
  deadline: null,
  listExcerpt: {},
  detailExcerpt: null,
  pdfText: {},
  customFields: [],
  unansweredRequired: [],
  canonicalLatex: "\\documentclass{article}",
  profile: { studentId: "PES1", platform: {}, manual: {} },
  approvedAnswers: [],
  callbackUrl: "https://example.com/draft/callback",
  callbackSecret: secret,
};

function baseEnv(): Config {
  return {
    HOST: "0.0.0.0",
    PORT: 10000,
    LOG_LEVEL: "silent",
    CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
    DRAFT_CALLBACK_SECRET: secret,
    PUBLIC_BASE_URL: "https://example.com",
  } as Config;
}

describe("GET /draft/prepare-payload", () => {
  it("rejects missing bearer", async () => {
    const app = buildServer(baseEnv());
    const res = await app.inject({
      method: "GET",
      url: "/draft/prepare-payload?driveId=drive-1",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects missing driveId", async () => {
    const app = buildServer(baseEnv());
    const res = await app.inject({
      method: "GET",
      url: "/draft/prepare-payload",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns stored pending payload", async () => {
    const drafts: Array<Record<string, unknown>> = [
      {
        id: "draft-1",
        drive_id: "drive-1",
        status: "pending",
        latex: null,
        answers: [],
        error: null,
        callback_at: null,
        delivered_at: null,
        request_payload: payload,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ];

    vi.spyOn(dbClient, "createDbClient").mockReturnValue({
      from(table: string) {
        if (table !== "draft") {
          throw new Error(`unexpected ${table}`);
        }
        return {
          select: () => ({
            eq: (_c: string, driveId: string) => {
              const matches = drafts.filter((d) => d.drive_id === driveId);
              return {
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: matches[0] ?? null, error: null }),
                  }),
                }),
                maybeSingle: async () => ({ data: matches[0] ?? null, error: null }),
              };
            },
          }),
        };
      },
    } as never);

    const app = buildServer(baseEnv());
    const res = await app.inject({
      method: "GET",
      url: "/draft/prepare-payload?driveId=drive-1",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ driveId: "drive-1", company: "Acme" });
    await app.close();
    vi.restoreAllMocks();
  });

  it("returns 404 when no pending payload", async () => {
    vi.spyOn(dbClient, "createDbClient").mockReturnValue({
      from() {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      },
    } as never);

    const app = buildServer(baseEnv());
    const res = await app.inject({
      method: "GET",
      url: "/draft/prepare-payload?driveId=missing",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
    vi.restoreAllMocks();
  });
});
