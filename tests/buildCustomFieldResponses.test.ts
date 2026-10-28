import { describe, expect, it } from "vitest";
import { buildCustomFieldResponses, submitReplyText } from "../app/apply/submit.ts";
import type { CustomField } from "../app/draft/payload.ts";

const fields: CustomField[] = [
  { id: "field_1", label: "Why us?", type: "text", required: true, options: [] },
  { id: "field_2", label: "City", type: "dropdown", required: true, options: ["BLR", "HYD"] },
  { id: null, label: "Notes", type: "text", required: false, options: [] },
];

describe("buildCustomFieldResponses", () => {
  it("keys only by field id (or label when id null)", () => {
    const out = buildCustomFieldResponses(fields, [
      { label: "Why us?", value: "culture" },
      { label: "City", value: "BLR" },
      { label: "Notes", value: "hi" },
      { label: "Orphan leftover", value: "should-not-appear" },
    ]);
    expect(out).toEqual({
      field_1: "culture",
      field_2: "BLR",
      Notes: "hi",
    });
    expect(out["Orphan leftover"]).toBeUndefined();
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
