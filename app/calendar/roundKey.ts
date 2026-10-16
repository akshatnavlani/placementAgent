import type { CalendarRoundKey } from "../db/calendar.ts";
import type { MailClassification } from "../db/mail.ts";

export function roundKeyFromClassification(
  classification: MailClassification,
): CalendarRoundKey | null {
  if (classification === "assessment") {
    return "assessment";
  }
  if (classification === "interview") {
    return "interview";
  }
  return null;
}

export function roundKeyFromSubEventName(name: string | null | undefined): CalendarRoundKey | null {
  if (!name || typeof name !== "string") {
    return null;
  }
  const n = name.trim();
  if (/assessment/i.test(n)) {
    return "assessment";
  }
  if (/interview/i.test(n)) {
    return "interview";
  }
  return null;
}

/** Prefer interview keywords, then assessment, for reschedule/cancel inference from body. */
export function inferRoundKeyFromText(text: string): CalendarRoundKey | null {
  if (/interview/i.test(text)) {
    return "interview";
  }
  if (/assessment|online\s+test|hacker\s*rank|codility|oa\b/i.test(text)) {
    return "assessment";
  }
  return null;
}

export function roundKeyLabel(key: CalendarRoundKey): string {
  return key === "assessment" ? "Assessment" : "Interview";
}
