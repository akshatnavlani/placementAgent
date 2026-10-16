import { describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.ts";
import { deliverReadyDraft } from "../app/draft/deliver.ts";
import type { DriveRow } from "../app/db/drive.ts";
import { TelegramClient } from "../app/telegram/client.ts";

const baseConfig = {
  HOST: "0.0.0.0",
  PORT: 10000,
  LOG_LEVEL: "silent",
  CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
  TELEGRAM_BOT_TOKEN: "bot",
  TELEGRAM_ALLOWED_CHAT_ID: "1",
  TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-secret-0123456789abcdef",
} as Config;

function store(opts: {
  status: "ready" | "pending";
  delivered_at?: string | null;
  latex?: string;
  answers?: Array<{ label: string; value: string }>;
}) {
  const drive: DriveRow = {
    id: "d1",
    raw_list: {},
    raw_detail: {
      customFields: [{ label: "City", type: "dropdown", required: true, options: ["BLR", "HYD"] }],
    },
    updated_at_platform: null,
    is_eligible: true,
    deadline: null,
    status: "New",
    reminder_sent: false,
    draft_status: "ready",
    notion_page_id: null,
    pdf_urls: [],
    pdf_text: {},
    company_id: null,
    company_name: "Acme",
    company_username: null,
    event_name: "SDE",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    alerted_at: null,
    applied_at: null,
    last_apply_check_at: null,
  };
  const draft = {
    id: "dr1",
    drive_id: "d1",
    status: opts.status,
    latex: opts.latex ?? "% ats_match: 40\n\\documentclass{article}",
    answers: opts.answers ?? [{ label: "City", value: "BLR" }],
    error: null,
    callback_at: "2026-01-01T00:00:00.000Z",
    delivered_at: opts.delivered_at ?? null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  const db = {
    from(table: string) {
      if (table === "drive") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: drive, error: null }),
            }),
          }),
        };
      }
      if (table === "draft") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: draft, error: null }),
                }),
              }),
              maybeSingle: async () => ({ data: draft, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq() {
              return {
                eq() {
                  Object.assign(draft, payload);
                  return {
                    select: () => ({
                      maybeSingle: async () => ({ data: draft, error: null }),
                    }),
                  };
                },
              };
            },
          }),
        };
      }
      throw new Error(table);
    },
  };

  return { db: db as never, draft };
}

describe("deliverReadyDraft", () => {
  it("sends answers + tex and marks delivered when compile fails", async () => {
    const { db, draft } = store({ status: "ready" });
    const messages: string[] = [];
    const docs: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("sendDocument")) {
        const form = init?.body as FormData;
        const file = form.get("document") as File;
        docs.push(file.name);
      } else if (String(url).includes("sendMessage")) {
        const body = JSON.parse(String(init?.body)) as { text: string };
        messages.push(body.text);
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });

    const result = await deliverReadyDraft(
      {
        config: baseConfig,
        db,
        fetch: fetchMock as unknown as typeof fetch,
        telegram: new TelegramClient({
          botToken: "bot",
          fetch: fetchMock as unknown as typeof fetch,
        }),
        compile: {
          ensureTectonic: async () => {
            throw new Error("no tectonic");
          },
        },
      },
      "d1",
    );

    expect(result.kind).toBe("delivered");
    expect(docs.some((n) => n.endsWith(".tex"))).toBe(true);
    expect(messages.some((m) => m.includes("Draft ready for Acme"))).toBe(true);
    expect(messages.some((m) => m.includes("City: BLR"))).toBe(true);
    expect(messages.some((m) => m.includes("PDF skipped"))).toBe(true);
    expect(draft.delivered_at).toBeTruthy();
  });

  it("no-ops when already delivered", async () => {
    const { db } = store({ status: "ready", delivered_at: "2026-01-02T00:00:00.000Z" });
    const result = await deliverReadyDraft(
      {
        config: baseConfig,
        db,
        compile: { ensureTectonic: async () => undefined },
      },
      "d1",
    );
    expect(result.kind).toBe("already_delivered");
  });

  it("sends pdf when compile succeeds", async () => {
    const { db } = store({ status: "ready" });
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const docs: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("sendDocument")) {
        const form = init?.body as FormData;
        docs.push((form.get("document") as File).name);
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });

    const result = await deliverReadyDraft(
      {
        config: baseConfig,
        db,
        telegram: new TelegramClient({
          botToken: "bot",
          fetch: fetchMock as unknown as typeof fetch,
        }),
        compile: {
          ensureTectonic: async () => undefined,
          runCommand: async (_bin, _args, cwd) => {
            await writeFile(join(cwd, "resume.pdf"), Buffer.from("%PDF-ok"));
            return { code: 0, stderr: "" };
          },
        },
      },
      "d1",
    );
    expect(result).toEqual({ kind: "delivered", driveId: "d1", pdf: true });
    expect(docs.some((n) => n.endsWith(".pdf"))).toBe(true);
  });
});
