import { describe, expect, it } from "vitest";
import type { DriveRow } from "../app/db/drive.ts";
import { decodeCallback, encodeCallback } from "../app/telegram/buttons.ts";
import { formatDriveAlert, isUrgentDeadline } from "../app/telegram/format.ts";

const base: DriveRow = {
  id: "6ad05fd6b7a2c9401084f819",
  raw_list: {
    companyName: "Fidelity International",
    eventName: "Graduate Programmer",
    jobInfo: {
      jobLocation: "Bengaluru",
      positionOffered: "Graduate Programmer",
      fteCompensation: { amount: "12 LPA" },
      briefJobDescription: "Build things",
    },
    modeOfSelection: { rounds: [{ name: "OA", selection: "Online" }] },
  },
  raw_detail: null,
  updated_at_platform: "2026-01-01T00:00:00.000Z",
  is_eligible: true,
  deadline: "2026-10-16T03:30:00.000Z",
  status: "New",
  reminder_sent: false,
  draft_status: null,
  notion_page_id: null,
  pdf_urls: [],
  pdf_text: {},
  company_id: null,
  company_name: "Fidelity International",
  company_username: null,
  event_name: "Graduate Programmer",
  first_seen_at: "2026-01-01T00:00:00.000Z",
  last_seen_at: "2026-01-01T00:00:00.000Z",
  alerted_at: null,
  applied_at: null,
  last_apply_check_at: null,
};

describe("formatDriveAlert", () => {
  it("formats IST deadline and key fields without secrets", () => {
    const text = formatDriveAlert(base);
    expect(text).toContain("Fidelity International");
    expect(text).toContain("Graduate Programmer");
    expect(text).toContain("IST");
    expect(text).toContain("Bengaluru");
    expect(text).toContain("CTC:");
    expect(text).toContain("Rounds:");
    expect(text).not.toContain("token");
    expect(text).not.toContain("password");
    expect(text).not.toMatch(/\d{10}/);
  });

  it("prepends urgency when requested", () => {
    const text = formatDriveAlert(base, { urgent: true });
    expect(text.startsWith("Deadline is close")).toBe(true);
  });
});

describe("isUrgentDeadline", () => {
  it("is true when under 6 hours remain", () => {
    const now = new Date("2026-10-16T00:00:00.000Z");
    expect(isUrgentDeadline("2026-10-16T03:30:00.000Z", now)).toBe(true);
  });

  it("is false when more than 6 hours remain", () => {
    const now = new Date("2026-10-15T00:00:00.000Z");
    expect(isUrgentDeadline("2026-10-16T03:30:00.000Z", now)).toBe(false);
  });
});

describe("callback_data", () => {
  it("round-trips prepare, applied, and skip for a real-shaped id", () => {
    const id = "6ad05fd6b7a2c9401084f819";
    expect(decodeCallback(encodeCallback("prepare", id))).toEqual({ kind: "prepare", driveId: id });
    expect(decodeCallback(encodeCallback("applied", id))).toEqual({ kind: "applied", driveId: id });
    expect(decodeCallback(encodeCallback("skip", id))).toEqual({ kind: "skip", driveId: id });
    expect(encodeCallback("prepare", id).length).toBeLessThanOrEqual(64);
  });

  it("decodes Approve as ok", () => {
    expect(decodeCallback("ok")).toEqual({ kind: "approve" });
  });
});
