import type { DriveRow, DriveStatus } from "../db/drive.ts";
import { asRecord, compensation, pickString, roundsText } from "../telegram/format.ts";

const IST = "Asia/Kolkata";

export const LATER_STAGES: ReadonlySet<DriveStatus> = new Set([
  "Assessment",
  "Interview",
  "Accepted",
  "Rejected",
]);

export const WATCHER_STATUSES: ReadonlySet<DriveStatus> = new Set(["New", "Applied", "Not Applied"]);

export type NotionStatusName =
  | "New"
  | "Applied"
  | "Assessment"
  | "Interview"
  | "Accepted"
  | "Rejected"
  | "Not Applied";

function dateProperty(iso: string | null): { date: { start: string; time_zone: string } } | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return {
    date: {
      start: new Date(ms).toISOString(),
      time_zone: IST,
    },
  };
}

function textProperty(value: string | null): { rich_text: Array<{ type: "text"; text: { content: string } }> } | null {
  if (!value) {
    return null;
  }
  return {
    rich_text: [{ type: "text", text: { content: value.slice(0, 2000) } }],
  };
}

function statusProperty(name: NotionStatusName): { status: { name: NotionStatusName } } {
  return { status: { name } };
}

function titleProperty(title: string): {
  title: Array<{ type: "text"; text: { content: string } }>;
} {
  return {
    title: [{ type: "text", text: { content: title.slice(0, 2000) } }],
  };
}

export function driveTitle(row: DriveRow): string {
  const source = row.raw_detail ?? row.raw_list;
  const jobInfo = asRecord(source.jobInfo);
  const company = pickString(row.company_name, source.companyName) ?? "Unknown company";
  const role =
    pickString(row.event_name, source.eventName, jobInfo?.positionOffered) ?? "Role not listed";
  return `${company} — ${role}`;
}

export function readNotionStatus(properties: Record<string, unknown> | undefined): NotionStatusName | null {
  if (!properties) {
    return null;
  }
  const statusProp = asRecord(properties.Status);
  const status = asRecord(statusProp?.status);
  const name = pickString(status?.name);
  if (
    name === "New" ||
    name === "Applied" ||
    name === "Assessment" ||
    name === "Interview" ||
    name === "Accepted" ||
    name === "Rejected" ||
    name === "Not Applied"
  ) {
    return name;
  }
  return null;
}

/**
 * Build Notion properties. When `includeStatus` is false, Status is omitted (guard path).
 * When `statusOverride` is set, that value is written; otherwise Supabase drive.status is used
 * if it is a watcher-owned status.
 */
export function mapDriveProperties(
  row: DriveRow,
  options: { includeStatus?: boolean; statusOverride?: NotionStatusName } = {},
): Record<string, unknown> {
  const includeStatus = options.includeStatus !== false;
  const source = row.raw_detail ?? row.raw_list;
  const jobInfo = asRecord(source.jobInfo);
  const { stipend, ctc } = compensation(jobInfo);
  const location = pickString(jobInfo?.jobLocation, jobInfo?.location);
  const eventType = pickString(source.eventType);
  const rounds = roundsText(source);
  const updatedAt = pickString(row.updated_at_platform, source.updatedAt);

  const properties: Record<string, unknown> = {
    Name: titleProperty(driveTitle(row)),
  };

  const deadline = dateProperty(row.deadline);
  if (deadline) {
    properties.Deadline = deadline;
  }
  const updated = dateProperty(updatedAt);
  if (updated) {
    properties.Updated = updated;
  }
  const typeProp = textProperty(eventType);
  if (typeProp) {
    properties.Type = typeProp;
  }
  const locationProp = textProperty(location);
  if (locationProp) {
    properties.Location = locationProp;
  }
  const stipendProp = textProperty(stipend);
  if (stipendProp) {
    properties.Stipend = stipendProp;
  }
  const ctcProp = textProperty(ctc);
  if (ctcProp) {
    properties.CTC = ctcProp;
  }
  const roundsProp = textProperty(rounds);
  if (roundsProp) {
    properties.Rounds = roundsProp;
  }

  if (includeStatus) {
    const status =
      options.statusOverride ??
      (row.status && WATCHER_STATUSES.has(row.status) ? (row.status as NotionStatusName) : "New");
    properties.Status = statusProperty(status);
  }

  return properties;
}
