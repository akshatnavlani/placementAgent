import type { DbClient } from "./client.ts";

export type MailAccount = "pesu" | "personal";

export type MailClassification =
  | "shortlist_present"
  | "shortlist_absent"
  | "assessment"
  | "interview"
  | "rejection"
  | "offer_received"
  | "offer_accepted"
  | "offer_confirmed"
  | "reschedule"
  | "cancel"
  | "unresolved";

export type MailConfidence = "high" | "low";

export type MailRow = {
  id: string;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  account: MailAccount;
  drive_id: string | null;
  classification: MailClassification;
  confidence: MailConfidence;
  subject: string;
  snippet: string;
  classified_at: string;
  notified_at: string | null;
  raw_meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function mapRow(row: Record<string, unknown>): MailRow {
  return {
    id: String(row.id),
    gmail_message_id: String(row.gmail_message_id),
    gmail_thread_id: (row.gmail_thread_id as string | null) ?? null,
    account: row.account as MailAccount,
    drive_id: (row.drive_id as string | null) ?? null,
    classification: row.classification as MailClassification,
    confidence: row.confidence as MailConfidence,
    subject: typeof row.subject === "string" ? row.subject : "",
    snippet: typeof row.snippet === "string" ? row.snippet : "",
    classified_at: String(row.classified_at),
    notified_at: (row.notified_at as string | null) ?? null,
    raw_meta:
      row.raw_meta && typeof row.raw_meta === "object" && !Array.isArray(row.raw_meta)
        ? (row.raw_meta as Record<string, unknown>)
        : {},
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function getMailByMessageId(
  db: DbClient,
  account: MailAccount,
  gmailMessageId: string,
): Promise<MailRow | null> {
  const { data, error } = await db
    .from("mail")
    .select("*")
    .eq("account", account)
    .eq("gmail_message_id", gmailMessageId)
    .maybeSingle();
  if (error) {
    throw new Error(`mail getByMessageId failed: ${error.message}`);
  }
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function getMailById(db: DbClient, id: string): Promise<MailRow | null> {
  const { data, error } = await db.from("mail").select("*").eq("id", id).maybeSingle();
  if (error) {
    throw new Error(`mail getById failed: ${error.message}`);
  }
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function upsertMail(
  db: DbClient,
  input: {
    account: MailAccount;
    gmailMessageId: string;
    gmailThreadId?: string | null;
    driveId?: string | null;
    classification: MailClassification;
    confidence: MailConfidence;
    subject: string;
    snippet: string;
    rawMeta?: Record<string, unknown>;
    clearNotified?: boolean;
  },
  now: Date = new Date(),
): Promise<MailRow> {
  const iso = now.toISOString();
  const existing = await getMailByMessageId(db, input.account, input.gmailMessageId);
  if (existing) {
    const patch: Record<string, unknown> = {
      gmail_thread_id: input.gmailThreadId ?? existing.gmail_thread_id,
      drive_id: input.driveId !== undefined ? input.driveId : existing.drive_id,
      classification: input.classification,
      confidence: input.confidence,
      subject: input.subject,
      snippet: input.snippet,
      classified_at: iso,
      updated_at: iso,
      raw_meta: input.rawMeta ?? existing.raw_meta,
    };
    if (input.clearNotified) {
      patch.notified_at = null;
    }
    const { data, error } = await db
      .from("mail")
      .update(patch)
      .eq("id", existing.id)
      .select("*")
      .maybeSingle();
    if (error) {
      throw new Error(`mail update failed: ${error.message}`);
    }
    return mapRow((data ?? { ...existing, ...patch }) as Record<string, unknown>);
  }

  const { data, error } = await db
    .from("mail")
    .insert({
      gmail_message_id: input.gmailMessageId,
      gmail_thread_id: input.gmailThreadId ?? null,
      account: input.account,
      drive_id: input.driveId ?? null,
      classification: input.classification,
      confidence: input.confidence,
      subject: input.subject,
      snippet: input.snippet,
      classified_at: iso,
      notified_at: null,
      raw_meta: input.rawMeta ?? {},
      created_at: iso,
      updated_at: iso,
    })
    .select("*")
    .maybeSingle();
  if (error) {
    throw new Error(`mail insert failed: ${error.message}`);
  }
  if (!data) {
    throw new Error("mail insert returned no row");
  }
  return mapRow(data as Record<string, unknown>);
}

export async function markMailNotified(
  db: DbClient,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  const iso = now.toISOString();
  const { error } = await db
    .from("mail")
    .update({ notified_at: iso, updated_at: iso })
    .eq("id", id);
  if (error) {
    throw new Error(`mail markNotified failed: ${error.message}`);
  }
}

export async function bindMailDrive(
  db: DbClient,
  id: string,
  driveId: string,
  now: Date = new Date(),
  options: { clearNotified?: boolean } = {},
): Promise<void> {
  const patch: Record<string, unknown> = {
    drive_id: driveId,
    updated_at: now.toISOString(),
  };
  if (options.clearNotified) {
    patch.notified_at = null;
  }
  const { error } = await db.from("mail").update(patch).eq("id", id);
  if (error) {
    throw new Error(`mail bindDrive failed: ${error.message}`);
  }
}

export async function getMailSyncCursor(
  db: DbClient,
  account: MailAccount,
): Promise<string | null> {
  const { data, error } = await db.from("mail_sync").select("history_id").eq("account", account).maybeSingle();
  if (error) {
    throw new Error(`mail_sync get failed: ${error.message}`);
  }
  if (!data) {
    return null;
  }
  const id = (data as { history_id?: string | null }).history_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function setMailSyncCursor(
  db: DbClient,
  account: MailAccount,
  historyId: string | null,
  now: Date = new Date(),
): Promise<void> {
  const iso = now.toISOString();
  const existing = await db.from("mail_sync").select("account").eq("account", account).maybeSingle();
  if (existing.error) {
    throw new Error(`mail_sync lookup failed: ${existing.error.message}`);
  }
  if (existing.data) {
    const { error } = await db
      .from("mail_sync")
      .update({ history_id: historyId, updated_at: iso })
      .eq("account", account);
    if (error) {
      throw new Error(`mail_sync update failed: ${error.message}`);
    }
    return;
  }
  const { error } = await db.from("mail_sync").insert({
    account,
    history_id: historyId,
    updated_at: iso,
  });
  if (error) {
    throw new Error(`mail_sync insert failed: ${error.message}`);
  }
}
