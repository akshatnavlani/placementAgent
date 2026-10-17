import type { DriveRow } from "../db/drive.ts";
import type { MailClassificationResult } from "./classify.ts";
import { matchDrive } from "./matchDrive.ts";

const MARKETING_NOISE_RE = [
  /\bfree\s+spins?\b/i,
  /\bcasino\b/i,
  /\bbonus\s+cred/i,
  /\bsubscriber\s+benefit\b/i,
  /\bgoogle\s+store\s+credit\b/i,
  /\blinkedin\b/i,
  /\breacted\s+to\s+a\s+post\b/i,
  /\bactivity\s+feed\b/i,
  /\bopening\s+hours\b/i,
  /\bnouveau\s+message\b/i,
  /\bbonjour\b/i,
  /\bpixel\s+\d+\s+series\b/i,
];

const PLACEMENT_SHAPE_RE = [
  /\bshortlist/i,
  /\bplacement\b/i,
  /\bcampus\s+(?:recruit|hire|drive)\b/i,
  /\bpesu\b/i,
  /\bdrive\b/i,
  /\binternship\b/i,
  /\binterview\b/i,
  /\bassessment\b/i,
  /\bhackerrank\b/i,
  /\bhackerearth\b/i,
  /\boffer\s+letter\b/i,
  /\bjob\s+offer\b/i,
  /\bpre[- ]?placement\b/i,
  /\brecruitment\b/i,
];

export function looksLikeMarketingNoise(subject: string, body: string): boolean {
  const hay = `${subject}\n${body}`;
  return MARKETING_NOISE_RE.some((re) => re.test(hay));
}

export function looksPlacementShaped(subject: string, body: string): boolean {
  const hay = `${subject}\n${body}`;
  return PLACEMENT_SHAPE_RE.some((re) => re.test(hay));
}

/** Classifications that may notify / ask / write stage. */
export function isActionableMailClassification(
  result: MailClassificationResult,
): boolean {
  if (result.classification === "unresolved") {
    return false;
  }
  if (result.confidence !== "high") {
    return false;
  }
  return true;
}

/**
 * Gate: should this message enter notify/status paths?
 * Store+classify still happens; callers use this before applyClassification notify.
 */
export function shouldProcessPlacementMail(input: {
  subject: string;
  bodyText: string;
  classified: MailClassificationResult;
  drives: DriveRow[];
}): { ok: true } | { ok: false; reason: string } {
  if (looksLikeMarketingNoise(input.subject, input.bodyText)) {
    return { ok: false, reason: "marketing_noise" };
  }
  if (!isActionableMailClassification(input.classified)) {
    return { ok: false, reason: "not_actionable" };
  }
  const shaped = looksPlacementShaped(input.subject, input.bodyText);
  const match = matchDrive(input.drives, input.subject, input.bodyText);
  if (match.kind === "one" || match.kind === "many") {
    return { ok: true };
  }
  if (shaped) {
    // High-signal placement language but no drive yet — still process (may ask later only if ambiguous).
    return { ok: true };
  }
  return { ok: false, reason: "no_placement_signal" };
}
