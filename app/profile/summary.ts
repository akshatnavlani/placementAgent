import type { FullProfile } from "../db/profile.ts";

function present(value: string | undefined | null): string {
  return value && value.trim() !== "" ? value.trim() : "(blank)";
}

export function formatProfileSummary(profile: FullProfile): string {
  const m = profile.manual;
  const latexChars = profile.canonicalLatex?.length ?? 0;
  const latexLine =
    latexChars > 0
      ? `LaTeX: ${latexChars} chars` +
        (profile.canonicalLatexUpdatedAt ? ` (updated ${profile.canonicalLatexUpdatedAt})` : "")
      : "LaTeX: (missing — required before Prepare)";

  const lines = [
    "Profile summary",
    "",
    `Student: ${profile.studentId}`,
    `JEE percentile: ${present(m.jee?.percentile)}`,
    `JEE rank: ${present(m.jee?.rank)}`,
    `Coding: ${present(m.coding?.platform)} | ${present(m.coding?.url)}`,
    `Rating: ${present(m.coding?.rating)}`,
    `Contests: ${present(m.coding?.contests)}`,
    `Certifications: ${m.certifications?.length ? m.certifications.join(", ") : "(blank)"}`,
    `Awards: ${m.awards?.length ? m.awards.join(", ") : "(blank)"}`,
    `Projects: ${m.projects?.length ?? 0}`,
    latexLine,
    "",
    "Send /profile anytime to change this.",
  ];
  return lines.join("\n");
}
