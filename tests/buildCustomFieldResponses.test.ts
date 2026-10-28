import { describe, expect, it } from "vitest";
import { buildCustomFieldResponses, submitReplyText } from "../app/apply/submit.ts";
import type { CustomField } from "../app/draft/payload.ts";

const fields: CustomField[] = [
  { id: "field_1", label: "Why us?", type: "text", required: true, options: [] },
  { id: "field_2", label: "City", type: "dropdown", required: true, options: ["BLR", "HYD"] },
  { id: null, label: "Notes", type: "text", required: false, options: [] },
];

describe("buildCustomFieldResponses", () => {
  it("returns array items with fieldId/fieldLabel/fieldType/response", () => {
    const out = buildCustomFieldResponses(fields, [
      { label: "Why us?", value: "culture" },
      { label: "City", value: "BLR" },
      { label: "Notes", value: "hi" },
      { label: "Orphan leftover", value: "should-not-appear" },
    ]);
    expect(out).toEqual([
      { fieldId: "field_1", fieldLabel: "Why us?", fieldType: "text", response: "culture" },
      { fieldId: "field_2", fieldLabel: "City", fieldType: "dropdown", response: "BLR" },
      { fieldId: "Notes", fieldLabel: "Notes", fieldType: "text", response: "hi" },
    ]);
  });
});

describe("submitReplyText missing answers", () => {
  it("lists labels", () => {
    expect(submitReplyText({ kind: "missing_answers", labels: ["Why us?", "City"] })).toContain(
      "Why us?",
    );
  });

  it("includes http body message", () => {
    expect(
      submitReplyText({ kind: "apply_rejected", reason: "http 500: validation failed", status: 500 }),
    ).toBe("Apply rejected: http 500: validation failed");
  });
});
