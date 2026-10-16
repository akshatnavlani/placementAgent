import type { DriveRow } from "../db/drive.ts";
import type { MailClassification } from "../db/mail.ts";

export function formatStageChange(
  drive: DriveRow | null,
  classification: MailClassification,
  reason: string,
): string {
  const label = drive
    ? `${drive.company_name ?? "Unknown"} — ${drive.event_name ?? "role"}`
    : "unmatched drive";

  switch (classification) {
    case "shortlist_present":
      return `Shortlisted: ${label}\n(${reason})`;
    case "shortlist_absent":
      return `Not on shortlist: ${label}\n(${reason})`;
    case "assessment":
      return `Assessment: ${label}\n(${reason})`;
    case "interview":
      return `Interview: ${label}\n(${reason})`;
    case "rejection":
      return `Rejected: ${label}\n(${reason})`;
    case "offer_received":
      return `Offer received: ${label}\n(${reason})`;
    case "offer_accepted":
      return `Offer accepted: ${label}\n(${reason})`;
    case "offer_confirmed":
      return `Offer confirmed: ${label}\n(${reason})`;
    case "reschedule":
      return `Reschedule noted (no calendar yet): ${label}\n(${reason})`;
    case "cancel":
      return `Cancel noted (no calendar yet): ${label}\n(${reason})`;
    case "unresolved":
      return `Mail needs a drive match: ${label}\n(${reason})`;
    default:
      return `Mail update: ${label}\n(${reason})`;
  }
}

export function formatAmbiguousMail(
  subject: string,
  classification: MailClassification,
  reason: string,
): string {
  const subj = subject.trim() || "(no subject)";
  return `Which drive is this mail for?\n${subj}\nClassified: ${classification} (${reason})`;
}

export function driveChoiceLabel(company: string | null, eventName: string | null): string {
  const companyPart = company?.trim() || "Unknown";
  const rolePart = eventName?.trim();
  if (rolePart) {
    return `${companyPart} — ${rolePart}`.slice(0, 40);
  }
  return companyPart.slice(0, 40);
}
