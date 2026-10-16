import { describe, expect, it } from "vitest";
import { normalizeAnswerLabel, type AnswerRow } from "../app/db/answer.ts";
import type { FullProfile } from "../app/db/profile.ts";
import { buildDraftFacts, profileReadyForDraft } from "../app/profile/draftFacts.ts";
import { formatProfileSummary } from "../app/profile/summary.ts";

function profile(partial: Partial<FullProfile> = {}): FullProfile {
  return {
    studentId: "PES1UG00FAKE",
    platform: {
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "9999999999",
      dob: "2000-01-01",
      currentCGPA: 9.1,
    },
    platformSyncedAt: "2026-01-01T00:00:00.000Z",
    manual: {
      jee: { percentile: "99.1" },
      coding: { platform: "Codeforces", rating: "1800" },
    },
    canonicalLatex: "\\documentclass{article}\\begin{document}Hi\\end{document}",
    canonicalLatexUpdatedAt: "2026-01-02T00:00:00.000Z",
    onboarding: {},
    ...partial,
  };
}

describe("normalizeAnswerLabel", () => {
  it("trims and lowercases", () => {
    expect(normalizeAnswerLabel("  Full   Name ")).toBe("full name");
  });
});

describe("buildDraftFacts", () => {
  it("strips phone and DOB from platform", () => {
    const facts = buildDraftFacts(profile(), []);
    expect(facts.platformForDraft.phone).toBeUndefined();
    expect(facts.platformForDraft.dob).toBeUndefined();
    expect(facts.platformForDraft.name).toBe("Ada Lovelace");
    expect(facts.manual.jee?.percentile).toBe("99.1");
    expect(facts.canonicalLatex).toContain("documentclass");
  });

  it("only includes approved reusable answers", () => {
    const answers: AnswerRow[] = [
      {
        id: "1",
        label_normalized: "email",
        label_display: "Email",
        value: "ada@example.com",
        approved: true,
        reusable: true,
        drive_id: null,
      },
      {
        id: "2",
        label_normalized: "secret",
        label_display: "Secret",
        value: "nope",
        approved: false,
        reusable: true,
        drive_id: null,
      },
    ];
    const facts = buildDraftFacts(profile(), answers);
    expect(facts.answers).toEqual([{ label: "Email", value: "ada@example.com" }]);
  });
});

describe("profileReadyForDraft", () => {
  it("requires canonical latex", () => {
    expect(profileReadyForDraft(profile({ canonicalLatex: null })).ok).toBe(false);
    expect(profileReadyForDraft(profile()).ok).toBe(true);
  });
});

describe("formatProfileSummary", () => {
  it("mentions blanks and latex", () => {
    const text = formatProfileSummary(profile({ manual: {} }));
    expect(text).toContain("(blank)");
    expect(text).toContain("LaTeX:");
  });
});
