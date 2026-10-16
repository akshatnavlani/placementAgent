import type { FullProfile } from "./profile.ts";
import type { DbClient } from "./client.ts";

export type AnswerRow = {
  id: string;
  label_normalized: string;
  label_display: string;
  value: string;
  approved: boolean;
  reusable: boolean;
  drive_id: string | null;
};

export function normalizeAnswerLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function mapRow(row: Record<string, unknown>): AnswerRow {
  return {
    id: String(row.id),
    label_normalized: String(row.label_normalized),
    label_display: String(row.label_display),
    value: String(row.value),
    approved: Boolean(row.approved),
    reusable: Boolean(row.reusable),
    drive_id: (row.drive_id as string | null) ?? null,
  };
}

export async function listAnswers(db: DbClient): Promise<AnswerRow[]> {
  const { data, error } = await db.from("answer").select("*");
  if (error) {
    throw new Error(`answer list failed: ${error.message}`);
  }
  return (data ?? []).map((row) => mapRow(row as Record<string, unknown>));
}

export async function listApprovedReusable(db: DbClient): Promise<AnswerRow[]> {
  const all = await listAnswers(db);
  return all.filter((a) => a.approved && a.reusable && !a.drive_id);
}

/**
 * Upsert a global reusable answer by normalized label.
 * If skipIfApprovedExists and an approved non-empty value exists, leave it.
 */
export async function upsertReusableAnswer(
  db: DbClient,
  input: {
    labelDisplay: string;
    value: string;
    approved?: boolean;
    skipIfApprovedExists?: boolean;
  },
  now: Date = new Date(),
): Promise<void> {
  const labelNormalized = normalizeAnswerLabel(input.labelDisplay);
  if (!labelNormalized || input.value.trim() === "") {
    return;
  }
  const existing = (await listAnswers(db)).find(
    (a) => a.reusable && !a.drive_id && a.label_normalized === labelNormalized,
  );
  if (
    input.skipIfApprovedExists &&
    existing &&
    existing.approved &&
    existing.value.trim() !== ""
  ) {
    return;
  }

  const iso = now.toISOString();
  if (existing) {
    const { error } = await db
      .from("answer")
      .update({
        label_display: input.labelDisplay.trim(),
        value: input.value.trim(),
        approved: input.approved ?? true,
        reusable: true,
        updated_at: iso,
      })
      .eq("id", existing.id);
    if (error) {
      throw new Error(`answer update failed: ${error.message}`);
    }
    return;
  }

  const { error } = await db.from("answer").insert({
    label_normalized: labelNormalized,
    label_display: input.labelDisplay.trim(),
    value: input.value.trim(),
    approved: input.approved ?? true,
    reusable: true,
    drive_id: null,
    created_at: iso,
    updated_at: iso,
  });
  if (error) {
    throw new Error(`answer insert failed: ${error.message}`);
  }
}

function pickString(...values: unknown[]): string | null {
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

/** Deterministic seeds from platform + manual. Never phone or DOB. */
export async function preseedFromProfile(db: DbClient, profile: FullProfile): Promise<number> {
  const seeds: Array<{ label: string; value: string }> = [];
  const p = profile.platform;

  const name = pickString(p.name, p.studentName, p.fullName);
  if (name) {
    seeds.push({ label: "Full Name", value: name });
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts[0]) {
      seeds.push({ label: "First Name", value: parts[0]! });
    }
    if (parts.length > 1) {
      seeds.push({ label: "Last Name", value: parts.slice(1).join(" ") });
    }
  }
  const email = pickString(p.email, p.studentEmail, p.collegeEmail);
  if (email) {
    seeds.push({ label: "Email", value: email });
  }
  const department = pickString(p.department, p.branch);
  if (department) {
    seeds.push({ label: "Department", value: department });
  }
  const batch = pickString(p.batch, p.yearOfPassing);
  if (batch) {
    seeds.push({ label: "Batch", value: batch });
  }
  const degree = pickString(p.graduateDegree, p.degree);
  if (degree) {
    seeds.push({ label: "Degree", value: degree });
  }
  const cgpa = pickString(p.currentCGPA, p.cgpa, p.ugCGPA);
  if (cgpa) {
    seeds.push({ label: "CGPA", value: cgpa });
  }

  const m = profile.manual;
  if (m.jee?.percentile) {
    seeds.push({ label: "JEE Percentile", value: m.jee.percentile });
  }
  if (m.jee?.rank) {
    seeds.push({ label: "JEE Rank", value: m.jee.rank });
  }
  if (m.coding?.platform) {
    seeds.push({ label: "Coding Platform", value: m.coding.platform });
  }
  if (m.coding?.url) {
    seeds.push({ label: "Coding Profile URL", value: m.coding.url });
  }
  if (m.coding?.rating) {
    seeds.push({ label: "Coding Rating", value: m.coding.rating });
  }
  if (m.coding?.contests) {
    seeds.push({ label: "Contest Results", value: m.coding.contests });
  }
  if (m.certifications?.length) {
    seeds.push({ label: "Certifications", value: m.certifications.join(", ") });
  }
  if (m.awards?.length) {
    seeds.push({ label: "Awards", value: m.awards.join(", ") });
  }
  if (m.awards?.length || m.certifications?.length) {
    const combined = [...(m.awards ?? []), ...(m.certifications ?? [])].join("; ");
    seeds.push({ label: "Awards & Certifications", value: combined });
    seeds.push({ label: "Awards and Certifications", value: combined });
  }

  let count = 0;
  for (const seed of seeds) {
    await upsertReusableAnswer(db, {
      labelDisplay: seed.label,
      value: seed.value,
      approved: true,
      skipIfApprovedExists: true,
    });
    count += 1;
  }
  return count;
}

/**
 * Derive an answer for a drive question label from profile facts.
 * Used so Prepare does not re-ask awards/certs already collected in /profile.
 */
export function suggestAnswerFromProfile(label: string, profile: FullProfile): string | null {
  const n = normalizeAnswerLabel(label);
  const m = profile.manual;
  const awards = m.awards ?? [];
  const certs = m.certifications ?? [];
  const hasAward = /\bawards?\b/.test(n);
  const hasCert = /\bcertifications?\b|\bcertificates?\b/.test(n);

  if (hasAward && hasCert) {
    const parts = [...awards, ...certs];
    return parts.length > 0 ? parts.join("; ") : null;
  }
  if (hasAward && awards.length > 0) {
    return awards.join(", ");
  }
  if (hasCert && certs.length > 0) {
    return certs.join(", ");
  }
  return null;
}

/** Upsert profile-derived answers for any still-missing required field labels. */
export async function hydrateAnswersFromProfile(
  db: DbClient,
  profile: FullProfile,
  fieldLabels: string[],
): Promise<number> {
  const approved = await listApprovedReusable(db);
  const have = new Set(approved.map((a) => a.label_normalized));
  let n = 0;
  for (const label of fieldLabels) {
    const key = normalizeAnswerLabel(label);
    if (have.has(key)) {
      continue;
    }
    const value = suggestAnswerFromProfile(label, profile);
    if (!value) {
      continue;
    }
    await upsertReusableAnswer(db, {
      labelDisplay: label,
      value,
      approved: true,
      skipIfApprovedExists: true,
    });
    have.add(key);
    n += 1;
  }
  return n;
}
