import type { DriveRow } from "../db/drive.ts";

const IST = "Asia/Kolkata";
export const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function formatDeadlineIst(deadlineIso: string | null): string | null {
  if (!deadlineIso) {
    return null;
  }
  const ms = Date.parse(deadlineIso);
  if (!Number.isFinite(ms)) {
    return deadlineIso;
  }
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

function firstCompensationAmount(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
    return String(value);
  }
  const record = asRecord(value);
  if (record) {
    return pickString(record.amount, record.value) ?? firstCompensationAmount(record.amount);
  }
  if (Array.isArray(value) && value.length > 0) {
    return firstCompensationAmount(value[0]);
  }
  return null;
}

/** Shared with Notion map — compensation may be an object or a non-empty array. */
export function compensation(jobInfo: Record<string, unknown> | null): {
  stipend: string | null;
  ctc: string | null;
} {
  if (!jobInfo) {
    return { stipend: null, ctc: null };
  }
  const stipend =
    firstCompensationAmount(jobInfo.internshipCompensation) ??
    firstCompensationAmount(jobInfo.internshipStipend);
  const ctc =
    firstCompensationAmount(jobInfo.fteCompensation) ?? firstCompensationAmount(jobInfo.ctc);
  return { stipend, ctc };
}

function selectionLabel(round: Record<string, unknown>): string | null {
  const direct = pickString(round.selection, round.type, round.mode);
  if (direct) {
    return direct;
  }
  if (Array.isArray(round.selections) && round.selections.length > 0) {
    const parts = round.selections.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    if (parts.length > 0) {
      return parts.join(", ");
    }
  }
  return null;
}

/** Shared with Notion map — rounds may use `selection` or `selections[]`. */
export function roundsText(source: Record<string, unknown> | null): string | null {
  if (!source) {
    return null;
  }
  const mode = asRecord(source.modeOfSelection);
  const rounds = mode?.rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) {
    return null;
  }
  const parts: string[] = [];
  for (const round of rounds) {
    const r = asRecord(round);
    if (!r) {
      continue;
    }
    const name = pickString(r.name, r.roundName, r.title);
    const selection = selectionLabel(r);
    if (name && selection) {
      parts.push(`${name} (${selection})`);
    } else if (name) {
      parts.push(name);
    }
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

export function isUrgentDeadline(deadlineIso: string | null, now: Date = new Date()): boolean {
  if (!deadlineIso) {
    return false;
  }
  const ms = Date.parse(deadlineIso);
  if (!Number.isFinite(ms)) {
    return false;
  }
  const remaining = ms - now.getTime();
  return remaining > 0 && remaining < SIX_HOURS_MS;
}

export function formatDriveAlert(row: DriveRow, options: { urgent?: boolean } = {}): string {
  const source = row.raw_detail ?? row.raw_list;
  const jobInfo = asRecord(source.jobInfo);
  const company = pickString(row.company_name, source.companyName) ?? "Unknown company";
  const role =
    pickString(row.event_name, source.eventName, jobInfo?.positionOffered) ?? "Role not listed";
  const location = pickString(jobInfo?.jobLocation, jobInfo?.location);
  const deadline = formatDeadlineIst(row.deadline);
  const { stipend, ctc } = compensation(jobInfo);
  const rounds = roundsText(source);

  const lines: string[] = [];
  if (options.urgent) {
    lines.push("Deadline is close — under 6 hours left.");
    lines.push("");
  }
  lines.push(company);
  lines.push(role);
  if (deadline) {
    lines.push(`Deadline: ${deadline} IST`);
  }
  if (location) {
    lines.push(`Location: ${location}`);
  }
  if (stipend) {
    lines.push(`Stipend: ${stipend}`);
  }
  if (ctc) {
    lines.push(`CTC: ${ctc}`);
  }
  if (rounds) {
    lines.push(`Rounds: ${rounds}`);
  }
  return lines.join("\n");
}

/** Snapshot used to detect material re-alert changes. */
export function materialSnapshot(row: DriveRow): string {
  const source = row.raw_detail ?? row.raw_list;
  const jobInfo = asRecord(source.jobInfo);
  const brief = pickString(jobInfo?.briefJobDescription) ?? "";
  const eventName = pickString(row.event_name, source.eventName) ?? "";
  const deadline = row.deadline ?? "";
  const eligible = String(row.is_eligible);
  return [deadline, eligible, eventName, brief].join("\n");
}
