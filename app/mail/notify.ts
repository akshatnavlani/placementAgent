import type { SyncEventResult } from "../calendar/syncEvent.ts";
import type { DriveRow } from "../db/drive.ts";
import type { MailClassification } from "../db/mail.ts";

const IST = "Asia/Kolkata";

function formatIst(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

export function formatCalendarLine(calendar: SyncEventResult | null | undefined): string | null {
  if (!calendar || calendar.action === "skip") {
    return null;
  }
  if (!calendar.ok) {
    return `Calendar: skipped (${calendar.reason})`;
  }
  if (calendar.reason === "no_calendar_time") {
    return "Calendar: no calendar time";
  }
  if (calendar.action === "cancel") {
    if (calendar.reason === "already_cancelled") {
      return "Calendar: already cancelled";
    }
    return "Calendar: cancelled";
  }
  if (calendar.startAt) {
    const when = formatIst(calendar.startAt);
    if (calendar.action === "reschedule" || calendar.reason === "rescheduled" || calendar.reason === "updated") {
      return `Calendar: updated ${when} IST`;
    }
    return `Calendar: ${when} IST`;
  }
  if (calendar.reason === "calendar_not_configured") {
    return null;
  }
  return `Calendar: ${calendar.reason}`;
}

export function formatStageChange(
  drive: DriveRow | null,
  classification: MailClassification,
  reason: string,
  calendar?: SyncEventResult | null,
  subject?: string | null,
): string {
  const label = drive
    ? `${drive.company_name ?? "Unknown"} — ${drive.event_name ?? "role"}`
    : "unmatched drive";

  let base: string;
  switch (classification) {
    case "shortlist_present":
      base = `Shortlisted: ${label}\n(${reason})`;
      break;
    case "shortlist_absent":
      base = `Not on shortlist: ${label}\n(${reason})`;
      break;
    case "assessment":
      base = `Assessment: ${label}\n(${reason})`;
      break;
    case "interview":
      base = `Interview: ${label}\n(${reason})`;
      break;
    case "rejection":
      base = `Rejected: ${label}\n(${reason})`;
      break;
    case "offer_received":
      base = `Offer received: ${label}\n(${reason})`;
      break;
    case "offer_accepted":
      base = `Offer accepted: ${label}\n(${reason})`;
      break;
    case "offer_confirmed":
      base = `Offer confirmed: ${label}\n(${reason})`;
      break;
    case "reschedule":
      base = `Reschedule noted: ${label}\n(${reason})`;
      break;
    case "cancel":
      base = `Cancel noted: ${label}\n(${reason})`;
      break;
    case "unresolved":
      base = `Mail needs a drive match: ${label}\n(${reason})`;
      break;
    default:
      base = `Mail update: ${label}\n(${reason})`;
  }

  const subj = subject?.trim();
  if (subj) {
    const truncated = subj.length > 80 ? `${subj.slice(0, 77)}...` : subj;
    base = `${base}\nSubject: ${truncated}`;
  }

  const calLine = formatCalendarLine(calendar);
  return calLine ? `${base}\n${calLine}` : base;
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
