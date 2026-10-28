import { describe, expect, it } from "vitest";
import type { DriveRow } from "../app/db/drive.ts";
import type { CatalogEvent } from "../app/placement/client.ts";
import type { DiffAction } from "../app/poll/diff.ts";
import { shouldAlert } from "../app/telegram/dedup.ts";

function row(partial: Partial<DriveRow> & { id: string }): DriveRow {
  return {
    raw_list: { _id: partial.id, eventName: "Role", jobInfo: { briefJobDescription: "desc" } },
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
    event_name: "Role",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    alerted_at: null,
    applied_at: null,
    last_apply_check_at: null,
    last_rejection_ask_at: null,
    ...partial,
  };
}

function action(partial: Partial<DiffAction> & { kind: DiffAction["kind"]; id: string }): DiffAction {
  return {
    isEligible: true,
    statusOnInsert: null,
    setStatusNewIfNull: false,
    fetchDetail: false,
    ...partial,
  };
}

describe("shouldAlert", () => {
  it("alerts on insert New eligible with null alerted_at", () => {
    const next = row({ id: "new-1", alerted_at: null });
    expect(
      shouldAlert({
        action: action({
          kind: "insert",
          id: "new-1",
          statusOnInsert: "New",
          event: { _id: "new-1", isEligible: true } as CatalogEvent,
        }),
        previous: undefined,
        next,
      }),
    ).toBe(true);
  });

  it("does not alert on touch", () => {
    const existing = row({ id: "e1", alerted_at: "2026-01-01T00:00:00.000Z" });
    expect(
      shouldAlert({
        action: action({ kind: "touch", id: "e1" }),
        previous: existing,
        next: existing,
      }),
    ).toBe(false);
  });

  it("does not alert ineligible", () => {
    const next = row({ id: "e1", is_eligible: false, status: null, alerted_at: null });
    expect(
      shouldAlert({
        action: action({ kind: "insert", id: "e1", isEligible: false, statusOnInsert: null }),
        previous: undefined,
        next,
      }),
    ).toBe(false);
  });

  it("re-alerts on material deadline change when already alerted", () => {
    const previous = row({
      id: "e1",
      alerted_at: "2026-01-01T00:00:00.000Z",
      applied_at: null,
      last_apply_check_at: null,
    last_rejection_ask_at: null,
      deadline: "2099-01-01T00:00:00.000Z",
    });
    const next = row({
      id: "e1",
      alerted_at: "2026-01-01T00:00:00.000Z",
      applied_at: null,
      last_apply_check_at: null,
    last_rejection_ask_at: null,
      deadline: "2099-06-01T00:00:00.000Z",
    });
    expect(
      shouldAlert({
        action: action({ kind: "refresh", id: "e1", fetchDetail: true }),
        previous,
        next,
      }),
    ).toBe(true);
  });

  it("does not re-alert when alerted_at set and material fields unchanged", () => {
    const previous = row({ id: "e1", alerted_at: "2026-01-01T00:00:00.000Z" });
    const next = row({ id: "e1", alerted_at: "2026-01-01T00:00:00.000Z" });
    expect(
      shouldAlert({
        action: action({ kind: "refresh", id: "e1", fetchDetail: true }),
        previous,
        next,
      }),
    ).toBe(false);
  });
});
