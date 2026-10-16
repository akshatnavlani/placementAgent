import { describe, expect, it } from "vitest";
import type { DriveRow } from "../app/db/drive.ts";
import { matchDrive } from "../app/mail/matchDrive.ts";

function drive(overrides: Partial<DriveRow>): DriveRow {
  return {
    id: "d1",
    raw_list: {},
    raw_detail: null,
    updated_at_platform: null,
    is_eligible: true,
    deadline: null,
    status: "Applied",
    reminder_sent: false,
    draft_status: null,
    notion_page_id: null,
    pdf_urls: [],
    pdf_text: {},
    company_id: null,
    company_name: "Acme Corp",
    company_username: "acme",
    event_name: "SDE Intern",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    alerted_at: null,
    applied_at: null,
    last_apply_check_at: null,
    ...overrides,
  };
}

describe("matchDrive", () => {
  it("returns none when no overlap", () => {
    const r = matchDrive(
      [drive({})],
      "Unrelated newsletter",
      "Buy shoes today",
    );
    expect(r.kind).toBe("none");
  });

  it("returns one clear Applied winner", () => {
    const r = matchDrive(
      [drive({ id: "acme-1" }), drive({ id: "other", company_name: "OtherCo", event_name: "Analyst" })],
      "Shortlist — Acme Corp SDE Intern",
      "Candidates shortlisted for Acme Corp SDE Intern role",
    );
    expect(r.kind).toBe("one");
    if (r.kind === "one") {
      expect(r.drive.id).toBe("acme-1");
    }
  });

  it("returns many when two Applied drives match", () => {
    const r = matchDrive(
      [
        drive({ id: "a1", event_name: "SDE Intern" }),
        drive({ id: "a2", event_name: "SDE Intern", company_username: "acme-corp" }),
      ],
      "Acme Corp SDE Intern shortlist",
      "Shortlist for Acme Corp SDE Intern",
    );
    expect(r.kind).toBe("many");
  });

  it("excludes Not Applied", () => {
    const r = matchDrive(
      [drive({ id: "na", status: "Not Applied" })],
      "Acme Corp SDE Intern shortlist",
      "Acme Corp SDE Intern",
    );
    expect(r.kind).toBe("none");
  });

  it("matches exactly one New with strong company+role", () => {
    const r = matchDrive(
      [drive({ id: "new-1", status: "New" })],
      "Acme Corp SDE Intern shortlist",
      "Shortlisted for Acme Corp SDE Intern",
    );
    expect(r.kind).toBe("one");
    if (r.kind === "one") {
      expect(r.drive.id).toBe("new-1");
    }
  });
});
