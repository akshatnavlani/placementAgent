import { describe, expect, it } from "vitest";
import type { DriveRow, DriveStatus } from "../app/db/drive.ts";
import { setMailStage } from "../app/db/drive.ts";

function memoryDb(status: DriveStatus | null) {
  const row: DriveRow = {
    id: "drive-1",
    raw_list: {},
    raw_detail: null,
    updated_at_platform: null,
    is_eligible: true,
    deadline: null,
    status,
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
  };
  const db = {
    from(table: string) {
      if (table !== "drive") {
        throw new Error(table);
      }
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: { ...row }, error: null }),
              };
            },
          };
        },
        update: (payload: Record<string, unknown>) => ({
          eq: async () => {
            Object.assign(row, payload);
            return { error: null };
          },
        }),
      };
    },
  };
  return { db: db as never, row };
}

describe("setMailStage", () => {
  it("allows Applied → Assessment", async () => {
    const { db, row } = memoryDb("Applied");
    const r = await setMailStage(db, "drive-1", "Assessment");
    expect(r).toEqual({ ok: true, from: "Applied" });
    expect(row.status).toBe("Assessment");
  });

  it("allows Assessment → Interview → Accepted", async () => {
    const { db, row } = memoryDb("Assessment");
    expect(await setMailStage(db, "drive-1", "Interview")).toMatchObject({ ok: true });
    expect(row.status).toBe("Interview");
    expect(await setMailStage(db, "drive-1", "Accepted")).toMatchObject({ ok: true });
    expect(row.status).toBe("Accepted");
  });

  it("rejects regress Interview → Assessment", async () => {
    const { db, row } = memoryDb("Interview");
    const r = await setMailStage(db, "drive-1", "Assessment");
    expect(r).toEqual({ ok: false, reason: "regress_or_same" });
    expect(row.status).toBe("Interview");
  });

  it("allows Rejected from Applied", async () => {
    const { db, row } = memoryDb("Applied");
    const r = await setMailStage(db, "drive-1", "Rejected");
    expect(r).toEqual({ ok: true, from: "Applied" });
    expect(row.status).toBe("Rejected");
  });

  it("does not touch Not Applied", async () => {
    const { db, row } = memoryDb("Not Applied");
    const r = await setMailStage(db, "drive-1", "Rejected");
    expect(r).toEqual({ ok: false, reason: "not_applied" });
    expect(row.status).toBe("Not Applied");
  });

  it("blocks New", async () => {
    const { db } = memoryDb("New");
    const r = await setMailStage(db, "drive-1", "Assessment");
    expect(r).toEqual({ ok: false, reason: "not_applied_yet" });
  });

  it("blocks Accepted → Rejected", async () => {
    const { db } = memoryDb("Accepted");
    const r = await setMailStage(db, "drive-1", "Rejected");
    expect(r).toEqual({ ok: false, reason: "cannot_reject" });
  });
});
