import type { AnswerRow } from "../db/answer.ts";
import type { FullProfile } from "../db/profile.ts";
import type { ManualProfile } from "./manual.ts";

const STRIP_FROM_DRAFT = new Set([
  "password",
  "token",
  "resetToken",
  "phone",
  "phoneNumber",
  "mobile",
  "mobileNumber",
  "dob",
  "dateOfBirth",
  "DateOfBirth",
  "birthDate",
]);

export type DraftFacts = {
  studentId: string;
  platformForDraft: Record<string, unknown>;
  manual: ManualProfile;
  canonicalLatex: string | null;
  answers: Array<{ label: string; value: string }>;
};

export function platformForDraft(platform: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(platform)) {
    if (STRIP_FROM_DRAFT.has(key)) {
      continue;
    }
    const lower = key.toLowerCase();
    if (lower.includes("phone") || lower.includes("dob") || lower.includes("birth")) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function buildDraftFacts(profile: FullProfile, answers: AnswerRow[]): DraftFacts {
  return {
    studentId: profile.studentId,
    platformForDraft: platformForDraft(profile.platform),
    manual: profile.manual,
    canonicalLatex: profile.canonicalLatex,
    answers: answers
      .filter((a) => a.approved && a.reusable && !a.drive_id)
      .map((a) => ({ label: a.label_display, value: a.value })),
  };
}

export type ProfileReadiness = {
  ok: boolean;
  missing: string[];
};

/** Hard gate for Prepare: canonical LaTeX required. Manual gaps are not blocking. */
export function profileReadyForDraft(profile: FullProfile): ProfileReadiness {
  const missing: string[] = [];
  if (!profile.canonicalLatex || profile.canonicalLatex.trim() === "") {
    missing.push("canonical_latex");
  }
  return { ok: missing.length === 0, missing };
}
