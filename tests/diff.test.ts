import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DriveRow } from "../app/db/drive.ts";
import type { CatalogEvent } from "../app/placement/client.ts";
import { diffCatalog, normalizeTimestamp } from "../app/poll/diff.ts";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const listFixture = JSON.parse(readFileSync(path.join(fixturesDir, "list.json"), "utf8")) as {
  events: CatalogEvent[];
};

function row(partial: Partial<DriveRow> & { id: string }): DriveRow {
  return {
    raw_list: {},
    raw_detail: null,
    updated_at_platform: null,
    is_eligible: true,
    deadline: null,
    status: "New",
    reminder_sent: false,
    draft_status: null,
    notion_page_id: null,
    pdf_urls: [],
    pdf_text: {},
    company_id: null,
    company_name: null,
    company_username: null,
    event_name: null,
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    alerted_at: null,
    applied_at: null,
    last_apply_check_at: null,
    ...partial,
  };
}

describe("normalizeTimestamp", () => {
  it("makes Z and +00:00 forms compare equal", () => {
    expect(normalizeTimestamp("2026-10-16T00:23:10.195Z")).toBe(
      normalizeTimestamp("2026-10-16T00:23:10.195+00:00"),
    );
  });
});

describe("diffCatalog", () => {
  it("inserts a new eligible _id as New", () => {
    const event = structuredClone(listFixture.events[0]!) as CatalogEvent;
    // Use a now before the fixture deadline so we do not also mark Not Applied.
    const now = new Date("2020-01-01T00:00:00.000Z");
    const { actions } = diffCatalog([event], [], now);
    expect(actions).toEqual([
      expect.objectContaining({
        kind: "insert",
        id: event._id,
        statusOnInsert: "New",
        fetchDetail: true,
      }),
    ]);
  });

  it("touches when updatedAt and eligibility are unchanged", () => {
    const event = structuredClone(listFixture.events[0]!) as CatalogEvent;
    // Simulate Postgres returning +00:00 instead of Z.
    const storedUpdated = String(event.updatedAt).replace("Z", "+00:00");
    const existing = [
      row({
        id: event._id,
        updated_at_platform: storedUpdated,
        is_eligible: true,
        deadline:
          typeof event.deadline === "string" ? String(event.deadline).replace("Z", "+00:00") : null,
        status: "New",
      }),
    ];
    // Use a now before deadline so we do not also mark Not Applied.
    const now = new Date("2020-01-01T00:00:00.000Z");
    const { actions } = diffCatalog([event], existing, now);
    expect(actions.map((a) => a.kind)).toEqual(["touch"]);
  });

  it("refreshes when only updatedAt changes", () => {
    const event = structuredClone(listFixture.events[0]!) as CatalogEvent;
    const existing = [
      row({
        id: event._id,
        updated_at_platform: "2000-01-01T00:00:00.000Z",
        is_eligible: true,
        deadline: typeof event.deadline === "string" ? event.deadline : null,
      }),
    ];
    const now = new Date("2020-01-01T00:00:00.000Z");
    const { actions } = diffCatalog([event], existing, now);
    expect(actions).toEqual([
      expect.objectContaining({ kind: "refresh", id: event._id, fetchDetail: true }),
    ]);
  });

  it("stores ineligible without New and alerts on missing isEligible", () => {
    const ineligible = {
      _id: "ineligible-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
      isEligible: false,
      deadline: "2099-01-01T00:00:00.000Z",
    } as CatalogEvent;
    const missing = {
      _id: "missing-flag-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deadline: "2099-01-01T00:00:00.000Z",
    } as CatalogEvent;

    const { actions, alerts } = diffCatalog([ineligible, missing], [], new Date("2026-01-02T00:00:00.000Z"));
    expect(actions.find((a) => a.id === "ineligible-1")).toMatchObject({
      kind: "insert",
      statusOnInsert: null,
      fetchDetail: false,
    });
    expect(actions.find((a) => a.id === "missing-flag-1")).toMatchObject({
      kind: "insert",
      statusOnInsert: null,
      fetchDetail: false,
      alertMissingEligibility: true,
    });
    expect(alerts).toContain("missing_isEligible:missing-flag-1");
  });

  it("marks New drives missing from a successful catalog as Not Applied", () => {
    const event = structuredClone(listFixture.events[0]!) as CatalogEvent;
    const existing = [
      row({ id: event._id, updated_at_platform: String(event.updatedAt), deadline: "2099-01-01T00:00:00.000Z" }),
      row({ id: "gone-drive", status: "New", deadline: "2099-01-01T00:00:00.000Z" }),
      row({ id: "already-applied", status: "Applied", deadline: "2099-01-01T00:00:00.000Z" }),
    ];
    const { actions } = diffCatalog([event], existing, new Date("2026-01-02T00:00:00.000Z"));
    expect(actions.filter((a) => a.kind === "markNotApplied").map((a) => a.id)).toEqual(["gone-drive"]);
  });

  it("marks New drives past deadline as Not Applied", () => {
    const event = {
      _id: "past-deadline",
      updatedAt: "2026-01-01T00:00:00.000Z",
      isEligible: true,
      deadline: "2026-01-01T12:00:00.000Z",
    } as CatalogEvent;
    const existing = [
      row({
        id: "past-deadline",
        updated_at_platform: "2026-01-01T00:00:00.000Z",
        is_eligible: true,
        deadline: "2026-01-01T12:00:00.000Z",
        status: "New",
      }),
    ];
    const { actions } = diffCatalog([event], existing, new Date("2026-01-02T00:00:00.000Z"));
    expect(actions.some((a) => a.kind === "markNotApplied" && a.id === "past-deadline")).toBe(true);
  });
});
