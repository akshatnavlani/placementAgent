import type { DbClient } from "./client.ts";

export type DriveStatus =
  | "New"
  | "Applied"
  | "Assessment"
  | "Interview"
  | "Accepted"
  | "Rejected"
  | "Not Applied";

export type DriveRow = {
  id: string;
  raw_list: Record<string, unknown>;
  raw_detail: Record<string, unknown> | null;
  updated_at_platform: string | null;
  is_eligible: boolean | null;
  deadline: string | null;
  status: DriveStatus | null;
  reminder_sent: boolean;
  draft_status: "pending" | "ready" | "failed" | null;
  notion_page_id: string | null;
  pdf_urls: string[];
  pdf_text: Record<string, string>;
  company_id: string | null;
  company_name: string | null;
  company_username: string | null;
  event_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
  alerted_at: string | null;
};

export type DriveUpsertFields = {
  id: string;
  rawList: Record<string, unknown>;
  updatedAtPlatform: string | null;
  isEligible: boolean | null;
  deadline: string | null;
  /** Only set on insert when eligible; never overwrite later stages via this helper. */
  statusOnInsert: DriveStatus | null;
  /** When flipping to eligible for the first time (status was null), set New. */
  setStatusNewIfNull: boolean;
  companyId: string | null;
  companyName: string | null;
  companyUsername: string | null;
  eventName: string | null;
  pdfUrls: string[];
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function asPdfText(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text === "string") {
      out[key] = text;
    }
  }
  return out;
}

function mapRow(row: Record<string, unknown>): DriveRow {
  return {
    id: String(row.id),
    raw_list: (row.raw_list as Record<string, unknown>) ?? {},
    raw_detail: (row.raw_detail as Record<string, unknown> | null) ?? null,
    updated_at_platform: (row.updated_at_platform as string | null) ?? null,
    is_eligible: (row.is_eligible as boolean | null) ?? null,
    deadline: (row.deadline as string | null) ?? null,
    status: (row.status as DriveStatus | null) ?? null,
    reminder_sent: Boolean(row.reminder_sent),
    draft_status: (row.draft_status as DriveRow["draft_status"]) ?? null,
    notion_page_id: (row.notion_page_id as string | null) ?? null,
    pdf_urls: asStringArray(row.pdf_urls),
    pdf_text: asPdfText(row.pdf_text),
    company_id: (row.company_id as string | null) ?? null,
    company_name: (row.company_name as string | null) ?? null,
    company_username: (row.company_username as string | null) ?? null,
    event_name: (row.event_name as string | null) ?? null,
    first_seen_at: String(row.first_seen_at),
    last_seen_at: String(row.last_seen_at),
    alerted_at: (row.alerted_at as string | null) ?? null,
  };
}

export async function listDrives(db: DbClient): Promise<DriveRow[]> {
  const { data, error } = await db.from("drive").select("*");
  if (error) {
    throw new Error(`drive list failed: ${error.message}`);
  }
  return (data ?? []).map((row) => mapRow(row as Record<string, unknown>));
}

export async function getDrive(db: DbClient, id: string): Promise<DriveRow | null> {
  const { data, error } = await db.from("drive").select("*").eq("id", id).maybeSingle();
  if (error) {
    throw new Error(`drive get failed: ${error.message}`);
  }
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function upsertFromList(db: DbClient, fields: DriveUpsertFields, now: Date = new Date()): Promise<void> {
  const existing = await getDrive(db, fields.id);
  const iso = now.toISOString();

  if (!existing) {
    const { error } = await db.from("drive").insert({
      id: fields.id,
      raw_list: fields.rawList,
      updated_at_platform: fields.updatedAtPlatform,
      is_eligible: fields.isEligible,
      deadline: fields.deadline,
      status: fields.statusOnInsert,
      pdf_urls: fields.pdfUrls,
      company_id: fields.companyId,
      company_name: fields.companyName,
      company_username: fields.companyUsername,
      event_name: fields.eventName,
      first_seen_at: iso,
      last_seen_at: iso,
      created_at: iso,
      updated_at: iso,
    });
    if (error) {
      throw new Error(`drive insert failed: ${error.message}`);
    }
    return;
  }

  let nextStatus = existing.status;
  if (fields.setStatusNewIfNull && existing.status === null && fields.isEligible === true) {
    nextStatus = "New";
  }

  const { error } = await db
    .from("drive")
    .update({
      raw_list: fields.rawList,
      updated_at_platform: fields.updatedAtPlatform,
      is_eligible: fields.isEligible,
      deadline: fields.deadline,
      status: nextStatus,
      pdf_urls: fields.pdfUrls,
      company_id: fields.companyId,
      company_name: fields.companyName,
      company_username: fields.companyUsername,
      event_name: fields.eventName,
      last_seen_at: iso,
      updated_at: iso,
    })
    .eq("id", fields.id);
  if (error) {
    throw new Error(`drive update failed: ${error.message}`);
  }
}

export async function setDetail(
  db: DbClient,
  id: string,
  rawDetail: Record<string, unknown>,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await db
    .from("drive")
    .update({ raw_detail: rawDetail, updated_at: now.toISOString() })
    .eq("id", id);
  if (error) {
    throw new Error(`drive setDetail failed: ${error.message}`);
  }
}

export async function setPdfText(
  db: DbClient,
  id: string,
  pdfUrls: string[],
  pdfText: Record<string, string>,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await db
    .from("drive")
    .update({
      pdf_urls: pdfUrls,
      pdf_text: pdfText,
      updated_at: now.toISOString(),
    })
    .eq("id", id);
  if (error) {
    throw new Error(`drive setPdfText failed: ${error.message}`);
  }
}

export async function touchLastSeen(db: DbClient, ids: string[], now: Date = new Date()): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const iso = now.toISOString();
  const { error } = await db.from("drive").update({ last_seen_at: iso, updated_at: iso }).in("id", ids);
  if (error) {
    throw new Error(`drive touchLastSeen failed: ${error.message}`);
  }
}

export async function markNotApplied(db: DbClient, ids: string[], now: Date = new Date()): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const iso = now.toISOString();
  const { error } = await db
    .from("drive")
    .update({ status: "Not Applied", last_seen_at: iso, updated_at: iso })
    .in("id", ids)
    .eq("status", "New");
  if (error) {
    throw new Error(`drive markNotApplied failed: ${error.message}`);
  }
}

export async function markAlerted(
  db: DbClient,
  id: string,
  options: { reminderSent?: boolean } = {},
  now: Date = new Date(),
): Promise<void> {
  const iso = now.toISOString();
  const patch: Record<string, unknown> = {
    alerted_at: iso,
    updated_at: iso,
  };
  if (options.reminderSent === true) {
    patch.reminder_sent = true;
  }
  const { error } = await db.from("drive").update(patch).eq("id", id);
  if (error) {
    throw new Error(`drive markAlerted failed: ${error.message}`);
  }
}
