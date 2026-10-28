import type { DbClient } from "./client.ts";
import type { PreparePayload } from "../draft/payload.ts";

export type DraftStatus = "pending" | "ready" | "failed";

export type DraftAnswer = { label: string; value: string };

export type DraftRow = {
  id: string;
  drive_id: string;
  status: DraftStatus;
  latex: string | null;
  answers: DraftAnswer[];
  error: string | null;
  callback_at: string | null;
  delivered_at: string | null;
  request_payload: PreparePayload | null;
  created_at: string;
  updated_at: string;
};

function asAnswers(value: unknown): DraftAnswer[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: DraftAnswer[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    if (typeof row.label === "string" && typeof row.value === "string") {
      out.push({ label: row.label, value: row.value });
    }
  }
  return out;
}

function asRequestPayload(value: unknown): PreparePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.driveId !== "string" || typeof row.callbackUrl !== "string") {
    return null;
  }
  return value as PreparePayload;
}

function mapRow(row: Record<string, unknown>): DraftRow {
  return {
    id: String(row.id),
    drive_id: String(row.drive_id),
    status: row.status as DraftStatus,
    latex: (row.latex as string | null) ?? null,
    answers: asAnswers(row.answers),
    error: (row.error as string | null) ?? null,
    callback_at: (row.callback_at as string | null) ?? null,
    delivered_at: (row.delivered_at as string | null) ?? null,
    request_payload: asRequestPayload(row.request_payload),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** Insert a new pending draft for a Prepare run. */
export async function insertPendingDraft(
  db: DbClient,
  driveId: string,
  now: Date = new Date(),
  requestPayload?: PreparePayload,
): Promise<void> {
  const iso = now.toISOString();
  const { error } = await db.from("draft").insert({
    drive_id: driveId,
    status: "pending",
    latex: null,
    answers: [],
    error: null,
    request_payload: requestPayload ?? null,
    created_at: iso,
    updated_at: iso,
  });
  if (error) {
    throw new Error(`draft insert failed: ${error.message}`);
  }
}

export async function getLatestDraft(db: DbClient, driveId: string): Promise<DraftRow | null> {
  const { data, error } = await db
    .from("draft")
    .select("*")
    .eq("drive_id", driveId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    // Fallback for mocks that only support select().eq().maybeSingle()
    const fallback = await db.from("draft").select("*").eq("drive_id", driveId).maybeSingle();
    if (fallback.error) {
      throw new Error(`draft getLatest failed: ${error.message}`);
    }
    return fallback.data ? mapRow(fallback.data as Record<string, unknown>) : null;
  }
  return data ? mapRow(data as Record<string, unknown>) : null;
}

/**
 * Latest pending draft's stored prepare payload (Claude Code fetch path).
 */
export async function getLatestPendingPayload(
  db: DbClient,
  driveId: string,
): Promise<PreparePayload | null> {
  const latest = await getLatestDraft(db, driveId);
  if (!latest || latest.status !== "pending" || !latest.request_payload) {
    return null;
  }
  return latest.request_payload;
}

export async function completeDraftReady(
  db: DbClient,
  driveId: string,
  latex: string,
  answers: DraftAnswer[],
  now: Date = new Date(),
): Promise<DraftRow | null> {
  const latest = await getLatestDraft(db, driveId);
  if (!latest || latest.status !== "pending") {
    return null;
  }
  const iso = now.toISOString();
  const { data, error } = await db
    .from("draft")
    .update({
      status: "ready",
      latex,
      answers,
      error: null,
      callback_at: iso,
      updated_at: iso,
    })
    .eq("id", latest.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) {
    throw new Error(`draft ready failed: ${error.message}`);
  }
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function failDraft(
  db: DbClient,
  driveId: string,
  errorMessage: string,
  now: Date = new Date(),
): Promise<DraftRow | null> {
  const latest = await getLatestDraft(db, driveId);
  if (!latest || latest.status !== "pending") {
    return null;
  }
  const iso = now.toISOString();
  const { data, error } = await db
    .from("draft")
    .update({
      status: "failed",
      error: errorMessage.slice(0, 2000),
      callback_at: iso,
      updated_at: iso,
    })
    .eq("id", latest.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) {
    throw new Error(`draft fail failed: ${error.message}`);
  }
  return data ? mapRow(data as Record<string, unknown>) : null;
}

/**
 * Fail a ready, undelivered draft (e.g. multi-page PDF after compile).
 */
export async function failReadyDraft(
  db: DbClient,
  driveId: string,
  errorMessage: string,
  now: Date = new Date(),
): Promise<DraftRow | null> {
  const latest = await getLatestDraft(db, driveId);
  if (!latest || latest.status !== "ready" || latest.delivered_at) {
    return null;
  }
  const iso = now.toISOString();
  const { data, error } = await db
    .from("draft")
    .update({
      status: "failed",
      error: errorMessage.slice(0, 2000),
      updated_at: iso,
    })
    .eq("id", latest.id)
    .eq("status", "ready")
    .select("*")
    .maybeSingle();
  if (error) {
    throw new Error(`draft failReady failed: ${error.message}`);
  }
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function markDraftDelivered(
  db: DbClient,
  driveId: string,
  now: Date = new Date(),
): Promise<DraftRow | null> {
  const latest = await getLatestDraft(db, driveId);
  if (!latest || latest.status !== "ready") {
    return null;
  }
  const iso = now.toISOString();
  const { data, error } = await db
    .from("draft")
    .update({
      delivered_at: iso,
      updated_at: iso,
    })
    .eq("id", latest.id)
    .eq("status", "ready")
    .select("*")
    .maybeSingle();
  if (error) {
    throw new Error(`draft deliver mark failed: ${error.message}`);
  }
  return data ? mapRow(data as Record<string, unknown>) : null;
}
