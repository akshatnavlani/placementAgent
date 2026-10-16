const NUMERIC_FIELDS = [
  "batch",
  "currentCGPA",
  "tenthPercentage",
  "twelfthPercentage",
  "activeBacklogs",
] as const;

const STRING_FIELDS = ["department", "graduateDegree"] as const;

export type EligibilityBody = {
  batch?: number;
  department?: string;
  graduateDegree?: string;
  currentCGPA?: number;
  tenthPercentage?: number;
  twelfthPercentage?: number;
  activeBacklogs?: number;
};

export type EligibilityBodyResult = {
  body: EligibilityBody;
  /** Field names omitted because the value was missing or not a usable number/string. */
  omitted: string[];
};

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return undefined;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

/**
 * Build the eligibility list body from a platform profile.
 * Exactly the seven verified fields. Omit missing. Keep real 0 as 0.
 * Never send ugCGPA, placementTier, internshipOfferedAt, or summerInternshipOfferedAt.
 */
export function buildEligibilityBody(profile: Record<string, unknown>): EligibilityBodyResult {
  const body: EligibilityBody = {};
  const omitted: string[] = [];

  for (const field of NUMERIC_FIELDS) {
    const raw = profile[field];
    if (raw === undefined || raw === null || raw === "") {
      omitted.push(field);
      continue;
    }
    const n = parseNumber(raw);
    if (n === undefined) {
      omitted.push(field);
      continue;
    }
    body[field] = n;
  }

  for (const field of STRING_FIELDS) {
    const raw = profile[field];
    if (raw === undefined || raw === null) {
      omitted.push(field);
      continue;
    }
    if (typeof raw !== "string" || raw.trim() === "") {
      omitted.push(field);
      continue;
    }
    body[field] = raw.trim();
  }

  return { body, omitted };
}
