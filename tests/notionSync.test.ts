import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DriveRow } from "../app/db/drive.ts";
import { NotionClient } from "../app/notion/client.ts";
import {
  resetNotionAuthAlertFlag,
  syncDrive,
  syncEligibleDrives,
} from "../app/notion/sync.ts";
import { TelegramClient } from "../app/telegram/client.ts";

function baseRow(overrides: Partial<DriveRow> = {}): DriveRow {
  return {
    id: "drive-1",
    raw_list: {
      _id: "drive-1",
      companyName: "Acme",
      eventName: "SDE",
      eventType: "Full Time",
      updatedAt: "2026-01-01T00:00:00.000Z",
      jobInfo: { jobLocation: "Bengaluru", positionOffered: "SDE" },
    },
    raw_detail: null,
    updated_at_platform: "2026-01-01T00:00:00.000Z",
    is_eligible: true,
    deadline: "2099-01-01T00:00:00.000Z",
    status: "New",
    reminder_sent: false,
    reminder_tiers_sent: [],
    draft_status: null,
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
    last_rejection_ask_at: null,
    ...overrides,
  };
}

function memoryDb(seed: DriveRow[]) {
  const rows = new Map(seed.map((r) => [r.id, structuredClone(r)]));
  const db = {
    from(table: string) {
      if (table !== "drive") {
        throw new Error(`unexpected ${table}`);
      }
      return {
        select() {
          return {
            eq(_col: string, id: string) {
              return {
                maybeSingle: async () => ({ data: rows.get(id) ?? null, error: null }),
              };
            },
            then(resolve: (v: { data: DriveRow[]; error: null }) => unknown) {
              return Promise.resolve(resolve({ data: [...rows.values()], error: null }));
            },
          };
        },
        update: (payload: Record<string, unknown>) => ({
          eq(_col: string, id: string) {
            const prev = rows.get(id);
            if (prev) {
              rows.set(id, { ...prev, ...payload } as DriveRow);
            }
            return {
              then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })),
            };
          },
        }),
      };
    },
  };
  return { db: db as never, rows };
}

beforeEach(() => {
  resetNotionAuthAlertFlag();
});

describe("syncDrive", () => {
  it("creates a page and stores notion_page_id", async () => {
    const { db, rows } = memoryDb([baseRow()]);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pages") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "page-abc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });
    const notion = new NotionClient({ token: "tok", fetch: fetchMock as unknown as typeof fetch });
    const result = await syncDrive({ db, notion, databaseId: "db-1" }, rows.get("drive-1")!);
    expect(result).toEqual({ ok: true, action: "created" });
    expect(rows.get("drive-1")?.notion_page_id).toBe("page-abc");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.properties.Status).toEqual({ status: { name: "New" } });
  });

  it("omits Status when Notion is Interview and Supabase is New", async () => {
    const { db, rows } = memoryDb([baseRow({ notion_page_id: "page-1", status: "New" })]);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/pages/page-1") && (!init?.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            id: "page-1",
            properties: { Status: { status: { name: "Interview" } } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/pages/page-1") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ id: "page-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });
    const notion = new NotionClient({ token: "tok", fetch: fetchMock as unknown as typeof fetch });
    const result = await syncDrive({ db, notion, databaseId: "db-1" }, rows.get("drive-1")!);
    expect(result).toEqual({ ok: true, action: "updated" });
    const patchCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PATCH");
    const body = JSON.parse(String(patchCall![1]?.body));
    expect(body.properties.Status).toBeUndefined();
    expect(body.properties.Name).toBeDefined();
  });

  it("writes Interview status when mail worker advanced the drive", async () => {
    const { db, rows } = memoryDb([
      baseRow({ notion_page_id: "page-1", status: "Interview" }),
    ]);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ id: "page-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });
    const notion = new NotionClient({ token: "tok", fetch: fetchMock as unknown as typeof fetch });
    const result = await syncDrive({ db, notion, databaseId: "db-1" }, rows.get("drive-1")!);
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.properties.Status).toEqual({ status: { name: "Interview" } });
  });

  it("writes Not Applied status", async () => {
    const { db, rows } = memoryDb([
      baseRow({ notion_page_id: "page-1", status: "Not Applied", is_eligible: false }),
    ]);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ id: "page-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });
    const notion = new NotionClient({ token: "tok", fetch: fetchMock as unknown as typeof fetch });
    const result = await syncDrive({ db, notion, databaseId: "db-1" }, rows.get("drive-1")!);
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.properties.Status).toEqual({ status: { name: "Not Applied" } });
  });

  it("sends ops alert once on auth failure", async () => {
    const { db } = memoryDb([baseRow()]);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ code: "unauthorized", message: "Invalid token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const sendMessage = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const telegram = { sendMessage } as unknown as TelegramClient;
    const notion = new NotionClient({ token: "bad", fetch: fetchMock as unknown as typeof fetch });

    const first = await syncDrive(
      { db, notion, databaseId: "db-1", telegram, chatId: "999" },
      baseRow(),
    );
    const second = await syncDrive(
      { db, notion, databaseId: "db-1", telegram, chatId: "999" },
      baseRow(),
    );
    expect(first.ok).toBe(false);
    expect(first).toMatchObject({ authError: true });
    expect(second.ok).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("syncEligibleDrives", () => {
  it("backfills New eligible rows missing page id", async () => {
    const { db, rows } = memoryDb([baseRow({ id: "backfill-1", notion_page_id: null })]);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "page-new" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const notion = new NotionClient({ token: "tok", fetch: fetchMock as unknown as typeof fetch });
    const summary = await syncEligibleDrives({
      db,
      notion,
      databaseId: "db-1",
      candidateIds: [],
      notAppliedIds: [],
    });
    expect(summary.synced).toBe(1);
    expect(rows.get("backfill-1")?.notion_page_id).toBe("page-new");
  });
});
