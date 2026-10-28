import { describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.ts";
import type { DriveRow } from "../app/db/drive.ts";
import { GmailClient } from "../app/gmail/client.ts";
import { syncRecruitmentMail } from "../app/mail/sync.ts";
import { TelegramClient } from "../app/telegram/client.ts";

const baseConfig = {
  HOST: "0.0.0.0",
  PORT: 10000,
  LOG_LEVEL: "silent",
  CRON_SHARED_SECRET: "test-cron-secret-0123456789abcdef0123456789",
  TELEGRAM_BOT_TOKEN: "bot-token",
  TELEGRAM_ALLOWED_CHAT_ID: "chat-1",
  TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-secret-0123456789abcdef",
} as Config;

function driveRow(): DriveRow {
  return {
    id: "6ad05fd6b7a2c9401084f819",
    raw_list: {},
    raw_detail: null,
    updated_at_platform: null,
    is_eligible: true,
    deadline: null,
    status: "Applied",
    reminder_sent: false,
    reminder_tiers_sent: [],
    draft_status: null,
    notion_page_id: "page-1",
    pdf_urls: [],
    pdf_text: {},
    company_id: null,
    company_name: "Acme Corp",
    company_username: "acme",
    event_name: "SDE Intern",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    alerted_at: null,
    applied_at: "2026-01-02T00:00:00.000Z",
    last_apply_check_at: null,
    last_rejection_ask_at: null,
  };
}

function mailStore() {
  const mail = new Map<string, Record<string, unknown>>();
  const sync = new Map<string, { history_id: string | null }>();
  const drives = new Map<string, DriveRow>([[driveRow().id, driveRow()]]);

  const db = {
    from(table: string) {
      if (table === "profile") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: {
                      student_id: "s1",
                      platform: { fullName: "Ada Lovelace" },
                      platform_synced_at: "2026-01-01T00:00:00.000Z",
                      manual: {},
                      canonical_latex: null,
                      canonical_latex_updated_at: null,
                      onboarding: {},
                    },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      if (table === "drive") {
        return {
          select() {
            return {
              eq(_c: string, id: string) {
                return {
                  maybeSingle: async () => ({ data: drives.get(id) ?? null, error: null }),
                };
              },
              then(resolve: (v: { data: DriveRow[]; error: null }) => unknown) {
                return Promise.resolve(resolve({ data: [...drives.values()], error: null }));
              },
            };
          },
          update: (payload: Record<string, unknown>) => ({
            eq(_c: string, id: string) {
              const prev = drives.get(id);
              if (prev) {
                drives.set(id, { ...prev, ...payload } as DriveRow);
              }
              return {
                then: (resolve: (v: { error: null }) => unknown) =>
                  Promise.resolve(resolve({ error: null })),
              };
            },
          }),
        };
      }
      if (table === "mail_sync") {
        return {
          select() {
            return {
              eq(_c: string, account: string) {
                return {
                  maybeSingle: async () => ({
                    data: sync.has(account)
                      ? { account, history_id: sync.get(account)!.history_id }
                      : null,
                    error: null,
                  }),
                };
              },
            };
          },
          update: (payload: Record<string, unknown>) => ({
            eq(_c: string, account: string) {
              sync.set(account, {
                history_id: (payload.history_id as string | null) ?? null,
              });
              return {
                then: (resolve: (v: { error: null }) => unknown) =>
                  Promise.resolve(resolve({ error: null })),
              };
            },
          }),
          insert: async (payload: Record<string, unknown>) => {
            sync.set(String(payload.account), {
              history_id: (payload.history_id as string | null) ?? null,
            });
            return { error: null };
          },
        };
      }
      if (table === "mail") {
        const emptyList = {
          is() {
            return emptyList;
          },
          neq() {
            return emptyList;
          },
          gte() {
            return emptyList;
          },
          order() {
            return emptyList;
          },
          limit: async () => ({ data: [], error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
          eq() {
            return emptyList;
          },
        };
        return {
          select() {
            return {
              eq(col: string, val: string) {
                return {
                  eq(col2: string, val2: string) {
                    return {
                      maybeSingle: async () => {
                        const key = `${val}:${val2}`;
                        return { data: mail.get(key) ?? null, error: null };
                      },
                    };
                  },
                  maybeSingle: async () => {
                    for (const row of mail.values()) {
                      if (row.id === val) {
                        return { data: row, error: null };
                      }
                    }
                    return { data: null, error: null };
                  },
                  // listUnnotifiedStageMail chain
                  is: () => emptyList,
                  neq: () => emptyList,
                  gte: () => emptyList,
                  order: () => emptyList,
                  limit: async () => ({ data: [], error: null }),
                };
              },
            };
          },
          insert: (payload: Record<string, unknown>) => ({
            select() {
              return {
                maybeSingle: async () => {
                  const id = `mail-${mail.size + 1}`;
                  const row = {
                    id,
                    ...payload,
                    created_at: payload.created_at ?? new Date().toISOString(),
                    updated_at: payload.updated_at ?? new Date().toISOString(),
                  };
                  mail.set(`${payload.account}:${payload.gmail_message_id}`, row);
                  return { data: row, error: null };
                },
              };
            },
          }),
          update: (payload: Record<string, unknown>) => ({
            eq(_c: string, id: string) {
              for (const [key, row] of mail) {
                if (row.id === id) {
                  const next = { ...row, ...payload };
                  mail.set(key, next);
                  return {
                    select() {
                      return {
                        maybeSingle: async () => ({ data: next, error: null }),
                      };
                    },
                    then: (resolve: (v: { error: null }) => unknown) =>
                      Promise.resolve(resolve({ error: null })),
                  };
                }
              }
              return {
                select() {
                  return { maybeSingle: async () => ({ data: null, error: null }) };
                },
                then: (resolve: (v: { error: null }) => unknown) =>
                  Promise.resolve(resolve({ error: null })),
              };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { db: db as never, mail, sync, drives };
}

describe("syncRecruitmentMail", () => {
  it("skips when no mailboxes configured", async () => {
    const { db } = mailStore();
    const summary = await syncRecruitmentMail({
      config: baseConfig,
      db,
      mailboxes: [],
    });
    expect(summary.accounts).toBe(0);
    expect(summary.processed).toBe(0);
  });

  it("bootstraps, classifies shortlist, notifies once; second pass skips", async () => {
    const { db, mail, drives } = mailStore();
    const body =
      "The following candidates have been shortlisted for Acme Corp SDE Intern:\n\n1. Ada Lovelace\n2. Alan Turing\n3. Grace Hopper\n\nAll the best to shortlisted candidates.\n";

    const gmailFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/profile")) {
        return new Response(JSON.stringify({ historyId: "hist-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/messages?") && url.includes("q=")) {
        return new Response(JSON.stringify({ messages: [{ id: "msg-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/messages/msg-1")) {
        return new Response(
          JSON.stringify({
            id: "msg-1",
            threadId: "thr-1",
            snippet: "shortlisted",
            internalDate: "1700000000000",
            payload: {
              headers: [{ name: "Subject", value: "Shortlist Acme Corp SDE Intern" }],
              mimeType: "text/plain",
              body: { data: Buffer.from(body).toString("base64url") },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });

    const client = new GmailClient({
      clientId: "cid",
      clientSecret: "sec",
      refreshToken: "ref",
      fetch: gmailFetch as unknown as typeof fetch,
    });

    const sendMessage = vi.fn(async () => ({ ok: true as const, messageId: "tg-1" }));
    const telegram = {
      sendMessage,
      answerCallbackQuery: vi.fn(),
    } as unknown as TelegramClient;

    const first = await syncRecruitmentMail({
      config: baseConfig,
      db,
      telegram,
      notify: true,
      mailboxes: [{ account: "pesu", client }],
    });
    expect(first.processed).toBe(1);
    expect(first.notified).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(drives.get(driveRow().id)?.status).toBe("Applied"); // shortlist_present leaves Applied
    expect(mail.size).toBe(1);

    // Second pass with cursor ? history empty ? skip
    const gmailFetch2 = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/history")) {
        return new Response(JSON.stringify({ historyId: "hist-2", history: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });
    const client2 = new GmailClient({
      clientId: "cid",
      clientSecret: "sec",
      refreshToken: "ref",
      fetch: gmailFetch2 as unknown as typeof fetch,
    });

    const second = await syncRecruitmentMail({
      config: baseConfig,
      db,
      telegram,
      notify: true,
      mailboxes: [{ account: "pesu", client: client2 }],
    });
    expect(second.processed).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("re-bootstraps on stale historyId", async () => {
    const { db, sync } = mailStore();
    sync.set("pesu", { history_id: "old-hist" });

    const gmailFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/history")) {
        return new Response(JSON.stringify({ error: { code: 404 } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/profile")) {
        return new Response(JSON.stringify({ historyId: "new-hist" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/messages?") && url.includes("q=")) {
        return new Response(JSON.stringify({ messages: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });

    const client = new GmailClient({
      clientId: "cid",
      clientSecret: "sec",
      refreshToken: "ref",
      fetch: gmailFetch as unknown as typeof fetch,
    });

    const summary = await syncRecruitmentMail({
      config: baseConfig,
      db,
      mailboxes: [{ account: "pesu", client }],
      notify: false,
    });
    expect(summary.ok).toBe(true);
    expect(sync.get("pesu")?.history_id).toBe("new-hist");
  });
});
