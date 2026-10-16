import { describe, expect, it } from "vitest";
import type { DriveRow } from "../app/db/drive.ts";
import {
  buildPreparePayload,
  extractCustomFields,
  preparePayloadLogKeys,
  unansweredRequiredLabels,
} from "../app/draft/payload.ts";
import type { DraftFacts } from "../app/profile/draftFacts.ts";

function drive(partial: Partial<DriveRow> = {}): DriveRow {
  return {
    id: "drive-1",
    raw_list: {
      companyName: "Acme",
      eventName: "SDE",
      password: "should-strip",
      customFields: [{ label: "Why us?", type: "text", required: true }],
    },
    raw_detail: {
      companyName: "Acme",
      customFields: [
        { id: "f1", label: "Why us?", type: "text", required: true },
        { id: "f2", label: "City", type: "dropdown", required: false, options: ["BLR", "HYD"] },
      ],
      bearerToken: "nope",
    },
    updated_at_platform: null,
    is_eligible: true,
    deadline: "2099-01-01T00:00:00.000Z",
    status: "New",
    reminder_sent: false,
    draft_status: null,
    notion_page_id: null,
    pdf_urls: ["https://example.com/a.pdf"],
    pdf_text: { "https://example.com/a.pdf": "JD text" },
    company_id: null,
    company_name: "Acme",
    company_username: null,
    event_name: "SDE",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    alerted_at: null,
    applied_at: null,
    last_apply_check_at: null,
    ...partial,
  };
}

const facts: DraftFacts = {
  studentId: "PES1UG00FAKE",
  platformForDraft: { name: "Ada", department: "CSE" },
  manual: { jee: { percentile: "99" } },
  canonicalLatex: "\\documentclass{article}\\begin{document}Hi\\end{document}",
  answers: [{ label: "Email", value: "a@b.com" }],
};

describe("extractCustomFields / unansweredRequired", () => {
  it("reads customFields and finds missing required", () => {
    const fields = extractCustomFields(drive().raw_detail);
    expect(fields).toHaveLength(2);
    expect(unansweredRequiredLabels(fields, facts.answers)).toEqual(["Why us?"]);
    expect(unansweredRequiredLabels(fields, [...facts.answers, { label: "Why us?", value: "x" }])).toEqual(
      [],
    );
  });
});

const callbackSecret = "draft-callback-secret-0123456789abcdef0123";

describe("buildPreparePayload", () => {
  it("builds a payload without placement secrets; includes callbackSecret for the agent", () => {
    const payload = buildPreparePayload({
      drive: drive(),
      facts,
      callbackUrl: "https://example.com/draft/callback",
      callbackSecret,
    });
    expect(payload.driveId).toBe("drive-1");
    expect(payload.company).toBe("Acme");
    expect(payload.canonicalLatex).toContain("documentclass");
    expect(payload.unansweredRequired).toEqual(["Why us?"]);
    expect(payload.callbackSecret).toBe(callbackSecret);
    expect(JSON.stringify(payload)).not.toMatch(/should-strip|bearerToken|nope/);
    expect(payload.profile.platform).toEqual({ name: "Ada", department: "CSE" });
    const keys = preparePayloadLogKeys(payload);
    expect(keys.keys).toContain("callbackUrl");
    expect(keys.keys).toContain("callbackSecret");
    expect(keys.hasCallbackSecret).toBe(true);
    expect(JSON.stringify(keys)).not.toContain(callbackSecret);
    expect(JSON.stringify(keys)).not.toContain("documentclass");
  });

  it("throws without latex", () => {
    expect(() =>
      buildPreparePayload({
        drive: drive(),
        facts: { ...facts, canonicalLatex: null },
        callbackUrl: "https://example.com/draft/callback",
        callbackSecret,
      }),
    ).toThrow(/latex/i);
  });
});
