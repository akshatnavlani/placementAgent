import type { CustomField } from "./payload.ts";

export function assertDropdownValue(
  field: Pick<CustomField, "options" | "type" | "label">,
  value: string,
): { ok: true } | { ok: false; reason: string } {
  const isDropdown =
    field.type?.toLowerCase() === "dropdown" ||
    field.type?.toLowerCase() === "select" ||
    (field.options?.length ?? 0) > 0;
  if (!isDropdown || field.options.length === 0) {
    return { ok: true };
  }
  if (field.options.includes(value)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Pick one of: ${field.options.slice(0, 12).join(", ")}${field.options.length > 12 ? "…" : ""}`,
  };
}

export function formatAnswersList(
  answers: Array<{ label: string; value: string }>,
  fields?: CustomField[],
): string {
  if (answers.length === 0) {
    return "No application answers for this drive.";
  }
  const byLabel = new Map(
    (fields ?? []).map((f) => [f.label.trim().toLowerCase(), f] as const),
  );
  const lines = answers.map((a) => {
    const field = byLabel.get(a.label.trim().toLowerCase());
    let suffix = "";
    if (field && field.options.length > 0 && !field.options.includes(a.value)) {
      suffix = " (not in options)";
    }
    return `${a.label}: ${a.value}${suffix}`;
  });
  return `Answers:\n${lines.join("\n")}`;
}

export function parseAtsComments(latex: string): { match?: string; note?: string } {
  const head = latex.slice(0, 800);
  const match = /%\s*ats_match:\s*(.+)/i.exec(head)?.[1]?.trim();
  const note = /%\s*ats_note:\s*(.+)/i.exec(head)?.[1]?.trim();
  return { match, note };
}

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "resume").slice(0, 64);
}
