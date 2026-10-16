import {
  asManual,
  asOnboarding,
  deepMergeManual,
  type ManualProfile,
  type OnboardingState,
} from "../profile/manual.ts";
import type { DbClient } from "./client.ts";

/** Fields that must never sit in the platform snapshot (placement password hash, etc.). */
const STRIP_FROM_PLATFORM = new Set(["password", "token", "resetToken"]);

export type FullProfile = {
  studentId: string;
  platform: Record<string, unknown>;
  platformSyncedAt: string | null;
  manual: ManualProfile;
  canonicalLatex: string | null;
  canonicalLatexUpdatedAt: string | null;
  onboarding: OnboardingState;
};

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
): Promise<{ studentId: string; platform: Record<string, unknown>; platformSyncedAt: string | null } | null> {
  const full = await loadFullProfile(db);
  if (!full) {
    return null;
  }
  return {
    studentId: full.studentId,
    platform: full.platform,
    platformSyncedAt: full.platformSyncedAt,
  };
}

export async function loadFullProfile(db: DbClient): Promise<FullProfile | null> {
  const { data, error } = await db
    .from("profile")
    .select(
      "student_id, platform, platform_synced_at, manual, canonical_latex, canonical_latex_updated_at, onboarding",
    )
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
    platformSyncedAt: (data.platform_synced_at as string | null) ?? null,
    manual: asManual(data.manual),
    canonicalLatex: typeof data.canonical_latex === "string" ? data.canonical_latex : null,
    canonicalLatexUpdatedAt: (data.canonical_latex_updated_at as string | null) ?? null,
    onboarding: asOnboarding(data.onboarding),
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
    onboarding: {},
    created_at: now,
    updated_at: now,
  });
  if (error) {
    throw new Error(`profile insert failed: ${error.message}`);
  }
}

export async function patchManual(db: DbClient, patch: ManualProfile, now: Date = new Date()): Promise<void> {
  const current = await loadFullProfile(db);
  if (!current) {
    throw new Error("profile patchManual failed: no profile row");
  }
  const merged = deepMergeManual(current.manual, patch);
  const { error } = await db
    .from("profile")
    .update({ manual: merged, updated_at: now.toISOString() })
    .eq("id", 1);
  if (error) {
    throw new Error(`profile patchManual failed: ${error.message}`);
  }
}

/** Full replace — used after redo confirm so stale keys do not linger. */
export async function replaceManual(
  db: DbClient,
  manual: ManualProfile,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await db
    .from("profile")
    .update({ manual, updated_at: now.toISOString() })
    .eq("id", 1);
  if (error) {
    throw new Error(`profile replaceManual failed: ${error.message}`);
  }
}

export async function setCanonicalLatex(db: DbClient, latex: string, now: Date = new Date()): Promise<void> {
  const iso = now.toISOString();
  const { error } = await db
    .from("profile")
    .update({
      canonical_latex: latex,
      canonical_latex_updated_at: iso,
      updated_at: iso,
    })
    .eq("id", 1);
  if (error) {
    throw new Error(`profile setCanonicalLatex failed: ${error.message}`);
  }
}

export async function setOnboarding(
  db: DbClient,
  onboarding: OnboardingState,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await db
    .from("profile")
    .update({ onboarding, updated_at: now.toISOString() })
    .eq("id", 1);
  if (error) {
    throw new Error(`profile setOnboarding failed: ${error.message}`);
  }
}

export async function clearOnboarding(db: DbClient, now: Date = new Date()): Promise<void> {
  await setOnboarding(db, {}, now);
}
