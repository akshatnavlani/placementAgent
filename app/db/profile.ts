import type { DbClient } from "./client.ts";

/** Fields that must never sit in the platform snapshot (placement password hash, etc.). */
const STRIP_FROM_PLATFORM = new Set(["password", "token", "resetToken"]);

export function sanitizePlatformSnapshot(platform: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(platform)) {
    if (STRIP_FROM_PLATFORM.has(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export async function loadPlatformProfile(
  db: DbClient,
): Promise<{ studentId: string; platform: Record<string, unknown> } | null> {
  const { data, error } = await db
    .from("profile")
    .select("student_id, platform")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    throw new Error(`profile load failed: ${error.message}`);
  }
  if (!data) {
    return null;
  }
  return {
    studentId: String(data.student_id),
    platform: (data.platform as Record<string, unknown>) ?? {},
  };
}

/** Upserts the platform snapshot only. Never writes `manual`. */
export async function upsertPlatformProfile(
  db: DbClient,
  studentId: string,
  platform: Record<string, unknown>,
  syncedAt: Date = new Date(),
): Promise<void> {
  const now = new Date().toISOString();
  const safePlatform = sanitizePlatformSnapshot(platform);
  const { data: existing, error: readError } = await db
    .from("profile")
    .select("id")
    .eq("id", 1)
    .maybeSingle();
  if (readError) {
    throw new Error(`profile read failed: ${readError.message}`);
  }

  if (existing) {
    const { error } = await db
      .from("profile")
      .update({
        student_id: studentId,
        platform: safePlatform,
        platform_synced_at: syncedAt.toISOString(),
        updated_at: now,
      })
      .eq("id", 1);
    if (error) {
      throw new Error(`profile update failed: ${error.message}`);
    }
    return;
  }

  const { error } = await db.from("profile").insert({
    id: 1,
    student_id: studentId,
    platform: safePlatform,
    platform_synced_at: syncedAt.toISOString(),
    manual: {},
    created_at: now,
    updated_at: now,
  });
  if (error) {
    throw new Error(`profile insert failed: ${error.message}`);
  }
}
