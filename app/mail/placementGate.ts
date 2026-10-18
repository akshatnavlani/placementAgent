import type { DriveRow } from "../db/drive.ts";
import {
  isCampusUpoSubject,
  isSystemIgnoreMail,
  type MailClassificationResult,
} from "./classify.ts";
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
  /\bstudy\s+abroad\b/i,
  /\bglobal\s+education\b/i,
];

/** Stage-shaped language (not UPO discovery blasts). */
const PLACEMENT_SHAPE_RE = [
  /\bshortlist/i,
  /\bhas\s+shared\s+the\s+shortlist\b/i,
  /\bcandidature\b/i,
  /\brejected\b/i,
  /\btechnical\s+interview\b/i,
  /\bvirtual\s+interview\b/i,
  /\binterview\s+(?:schedule|scheduled|tomorrow|timings?)\b/i,
  /\bgroup\s+discussion\b/i,
  /\bonline\s+assessment\b/i,
  /\bassessment\s+invitation\b/i,
  /\bwritten\s+test\b/i,
  /\bhackerrank\b/i,
  /\bhackerearth\b/i,
  /\boffer\s+letter\b/i,
  /\bjob\s+offer\b/i,
  /\backnowledge\s+the\s+offer\s+acceptance\b/i,
  /\bfinal\s+selects?\b/i,
  /\bpostponed\b/i,
  /\bcancell?ed\b/i,
];

export function looksLikeMarketingNoise(subject: string, body: string): boolean {
  if (isCampusUpoSubject(subject) || isSystemIgnoreMail(subject, body)) {
    return true;
  }
  const hay = `${subject}\n${body}`;
  return MARKETING_NOISE_RE.some((re) => re.test(hay));
}

export function looksPlacementShaped(subject: string, body: string): boolean {
  if (isCampusUpoSubject(subject)) {
    return false;
  }
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
  // Weak keyword offers must not notify or advance.
  if (result.reason === "offer_keywords_weak") {
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
  // High-signal stage language but no company match yet — still process so apply can
  // silent-skip or ask only when candidates exist. Do not open the gate for UPO-shaped noise.
  if (shaped) {
    return { ok: true };
  }
  return { ok: false, reason: "no_placement_signal" };
}
