import type { DriveRow, DriveStatus } from "../db/drive.ts";

const MATCHABLE: ReadonlySet<DriveStatus> = new Set([
  "Applied",
  "Assessment",
  "Interview",
  "Accepted",
]);

/** Tokens too common to count as a company hit alone. */
const STOP = new Set([
  "the",
  "and",
  "for",
  "pvt",
  "ltd",
  "limited",
  "private",
  "india",
  "pes",
  "pesu",
  "university",
  "campus",
  "drive",
  "internship",
  "intern",
  "engineer",
  "software",
  "graduate",
  "trainee",
  "member",
  "technical",
]);

export type DriveMatchCandidate = {
  drive: DriveRow;
  score: number;
};

export type DriveMatchResult =
  | { kind: "one"; drive: DriveRow; score: number }
  | { kind: "none" }
  | { kind: "many"; candidates: DriveMatchCandidate[] };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((t) => t.length >= 2);
}

function significantTokens(text: string): string[] {
  return tokens(text).filter((t) => !STOP.has(t) && t.length >= 3);
}

/** Exact token overlap only (no substring soft match). */
function overlapScore(hayTokens: Set<string>, needle: string): number {
  const parts = significantTokens(needle);
  if (parts.length === 0) {
    return 0;
  }
  let hits = 0;
  for (const p of parts) {
    if (hayTokens.has(p)) {
      hits += 1;
    }
  }
  return hits / parts.length;
}

function companyPresent(hay: string, hayTokens: Set<string>, company: string, username: string): boolean {
  const companyParts = significantTokens(company);
  if (companyParts.length > 0) {
    const hits = companyParts.filter((p) => hayTokens.has(p)).length;
    // Need majority of significant company tokens, or full company phrase in hay.
    if (hits >= Math.ceil(companyParts.length * 0.6) && hits >= 1) {
      return true;
    }
    const phrase = normalize(company);
    if (phrase.length >= 4 && hay.includes(phrase)) {
      return true;
    }
  }
  if (username) {
    const u = normalize(username);
    if (u.length >= 3 && (hayTokens.has(u) || hay.includes(u))) {
      return true;
    }
  }
  return false;
}

/**
 * Score company + role overlap in subject+body.
 * Match among Applied+; New only when exactly one New matches company strongly.
 * Requires a clear company (or username) presence — no fuzzy substring latch.
 */
export function matchDrive(
  drives: DriveRow[],
  subject: string,
  bodyText: string,
): DriveMatchResult {
  const hay = normalize(`${subject}\n${bodyText}`);
  const hayTokens = new Set(tokens(hay));

  const appliedPlus = drives.filter((d) => d.status && MATCHABLE.has(d.status));
  const scored: DriveMatchCandidate[] = [];

  for (const drive of appliedPlus) {
    const company = drive.company_name ?? "";
    const username = drive.company_username ?? "";
    const role = drive.event_name ?? "";
    if (!companyPresent(hay, hayTokens, company, username)) {
      continue;
    }
    let score = 0;
    if (company) {
      score += 3 * overlapScore(hayTokens, company);
    }
    if (username) {
      score += 2 * overlapScore(hayTokens, username);
    }
    if (role) {
      score += 1.5 * overlapScore(hayTokens, role);
    }
    // Floor: company must contribute real score.
    if (score < 1.8) {
      continue;
    }
    scored.push({ drive, score });
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 1) {
    return { kind: "one", drive: scored[0]!.drive, score: scored[0]!.score };
  }
  if (scored.length >= 2) {
    const top = scored[0]!.score;
    const clear = scored.filter((c) => c.score >= top - 0.25 && c.score >= 2.2);
    if (clear.length === 1) {
      return { kind: "one", drive: clear[0]!.drive, score: clear[0]!.score };
    }
    return { kind: "many", candidates: clear.length > 0 ? clear : scored.slice(0, 5) };
  }

  // Fallback: exactly one New with strong company match.
  const news = drives.filter((d) => d.status === "New");
  const newScored: DriveMatchCandidate[] = [];
  for (const drive of news) {
    const company = drive.company_name ?? "";
    const username = drive.company_username ?? "";
    const role = drive.event_name ?? "";
    if (!companyPresent(hay, hayTokens, company, username)) {
      continue;
    }
    const companyScore = company ? overlapScore(hayTokens, company) : 0;
    const roleScore = role ? overlapScore(hayTokens, role) : 0;
    if (companyScore < 0.6) {
      continue;
    }
    const score = 3 * companyScore + 2 * roleScore;
    if (score < 2.5) {
      continue;
    }
    newScored.push({ drive, score });
  }
  if (newScored.length === 1) {
    return { kind: "one", drive: newScored[0]!.drive, score: newScored[0]!.score };
  }
  if (newScored.length > 1) {
    return { kind: "many", candidates: newScored.slice(0, 5) };
  }

  return { kind: "none" };
}
