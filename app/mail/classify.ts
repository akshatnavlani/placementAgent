export type MailClassificationResult = {
  classification:
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
  confidence: "high" | "low";
  namePresent?: boolean;
  listComplete?: boolean;
  reason: string;
};

export type ClassifyInput = {
  subject: string;
  snippet: string;
  bodyText: string;
  /** Display-name tokens from profile (fullName / name / studentName). */
  studentNameTokens: string[];
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function nameTokensFromProfile(platform: Record<string, unknown>): string[] {
  const raw = [platform.fullName, platform.name, platform.studentName]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .join(" ");
  const tokens = normalize(raw)
    .split(" ")
    .filter((t) => t.length >= 2);
  return [...new Set(tokens)];
}

export function namePresentInText(text: string, studentNameTokens: string[]): boolean {
  if (studentNameTokens.length === 0) {
    return false;
  }
  const hay = normalize(text);
  const hayTokens = new Set(hay.split(" ").filter(Boolean));
  // Require at least half of tokens (min 1); prefer full surname+given overlap when ≥2 tokens.
  const hits = studentNameTokens.filter((t) => hayTokens.has(t) || hay.includes(t));
  if (studentNameTokens.length >= 2) {
    return hits.length >= Math.ceil(studentNameTokens.length * 0.5) && hits.length >= 2;
  }
  return hits.length >= 1;
}

function combinedText(input: ClassifyInput): string {
  return `${input.subject}\n${input.snippet}\n${input.bodyText}`;
}

function hasAny(hay: string, needles: RegExp[]): boolean {
  return needles.some((re) => re.test(hay));
}

const CANCEL_RE = [
  /\bcancell?ed\b/i,
  /\bcancellation\b/i,
  /\bdrive\s+cancelled\b/i,
  /\bevent\s+cancelled\b/i,
];
const RESCHEDULE_RE = [
  /\breschedul/i,
  /\bpostponed\b/i,
  /\bnew\s+date\b/i,
  /\btiming\s+changed\b/i,
];
const OFFER_ACCEPT_YOU_RE = [
  /\bi\s+(?:would\s+like\s+to\s+)?accept\b/i,
  /\baccepting\s+the\s+offer\b/i,
  /\bhereby\s+accept\b/i,
  /\bgladly\s+accept\b/i,
];
const OFFER_CONFIRMED_RE = [
  /\boffer\s+(?:has\s+been\s+)?confirm/i,
  /\bacceptance\s+(?:has\s+been\s+)?confirm/i,
  /\bconfirmed\s+your\s+acceptance\b/i,
  /\bwelcome\s+aboard\b/i,
];
/** Job-offer only — avoid marketing “special offer”, casino, store credit. */
const OFFER_RE = [
  /\b(?:job|placement|internship|ppo|full[- ]?time)\s+offer\b/i,
  /\boffer\s+of\s+(?:employment|internship)\b/i,
  /\b(?:employment|internship)\s+offer\b/i,
  /\boffer\s+letter\b/i,
  /\bcongratulations\b[\s\S]{0,80}\b(?:job\s+)?offer\b/i,
  /\bwe\s+(?:are\s+)?(?:pleased|happy|delighted)\s+to\s+(?:extend|make|offer)\b/i,
];
const OFFER_NOISE_RE = [
  /\bfree\s+spins?\b/i,
  /\bcasino\b/i,
  /\bsubscriber\s+benefit\b/i,
  /\bgoogle\s+store\b/i,
  /\bspecial\s+offer\b/i,
  /\blimited[- ]time\s+offer\b/i,
];
const REJECTION_RE = [
  /\bnot\s+shortlisted\b/i,
  /\bregret\s+to\s+inform\b/i,
  /\bwe\s+regret\b/i,
  /\bunfortunately[\s\S]{0,60}\b(?:not\s+selected|rejected|not\s+shortlisted)\b/i,
  /\byou\s+(?:have\s+)?(?:been\s+)?rejected\b/i,
  /\bapplication\s+(?:has\s+been\s+)?rejected\b/i,
];
const INTERVIEW_RE = [
  /\btechnical\s+interview\b/i,
  /\bhr\s+(?:round|interview)\b/i,
  /\binterview\s+(?:schedule|scheduled|invite|invitation|round)\b/i,
  /\bscheduled\s+(?:an?\s+)?interview\b/i,
  /\binterview\b/i,
];
const ASSESSMENT_RE = [
  /\bonline\s+assessment\b/i,
  /\b\boa\b/i,
  /\bhackerrank\b/i,
  /\bhackerearth\b/i,
  /\bassessment\s+(?:link|test|round)\b/i,
  /\btest\s+link\b/i,
  /\bcoding\s+(?:test|assessment)\b/i,
  /\bonline\s+test\b/i,
];
const SHORTLIST_RE = [
  /\bshortlist(?:ed|ing)?\b/i,
  /\bselected\s+for\s+(?:the\s+)?(?:next\s+)?round\b/i,
  /\bshort\s*listed\b/i,
  /\bcandidates?\s+selected\b/i,
];
const LIST_COMPLETE_RE = [
  /\bfollowing\s+candidates?\b/i,
  /\bbelow\s+(?:is\s+)?(?:the\s+)?(?:list\s+of\s+)?(?:shortlisted\s+)?candidates?\b/i,
  /\ball\s+the\s+best\s+to\s+(?:the\s+)?shortlisted\b/i,
  /\bshortlisted\s+candidates?\s+(?:are|were)\b/i,
  /\bhere\s+(?:is|are)\s+the\s+(?:final\s+)?(?:list|names)\b/i,
  /\benumerated\s+below\b/i,
];

/** Heuristic: many lines that look like person names (2+ capitalized words). */
function looksEnumeratedNameList(body: string): boolean {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let nameLines = 0;
  for (const line of lines) {
    // Strip leading numbering
    const cleaned = line.replace(/^\d+[\).:\-\s]+/, "").replace(/^[-*•]\s+/, "");
    if (/^[A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+){1,3}$/.test(cleaned)) {
      nameLines += 1;
    }
  }
  return nameLines >= 3;
}

/**
 * Ordered rule classifier. First high-confidence win.
 * Low confidence → unresolved (never auto-reject on weak signals).
 */
export function classifyRecruitmentMail(input: ClassifyInput): MailClassificationResult {
  const text = combinedText(input);
  const subject = input.subject;

  if (hasAny(text, CANCEL_RE) && !hasAny(text, RESCHEDULE_RE)) {
    return { classification: "cancel", confidence: "high", reason: "cancel_keywords" };
  }
  if (hasAny(text, RESCHEDULE_RE)) {
    return { classification: "reschedule", confidence: "high", reason: "reschedule_keywords" };
  }

  // Offer subtypes before generic offer.
  if (!hasAny(text, OFFER_NOISE_RE)) {
    if (hasAny(text, OFFER_CONFIRMED_RE)) {
      return { classification: "offer_confirmed", confidence: "high", reason: "offer_confirmation" };
    }
    if (hasAny(text, OFFER_ACCEPT_YOU_RE) && hasAny(text, OFFER_RE)) {
      return { classification: "offer_accepted", confidence: "high", reason: "student_acceptance" };
    }
    if (hasAny(text, OFFER_RE)) {
      return { classification: "offer_received", confidence: "high", reason: "offer_keywords" };
    }
  }

  if (hasAny(text, REJECTION_RE)) {
    // Prefer high when clearly addressed; still high for common HR phrases.
    return { classification: "rejection", confidence: "high", reason: "rejection_keywords" };
  }

  if (hasAny(text, INTERVIEW_RE) && !hasAny(text, SHORTLIST_RE)) {
    return { classification: "interview", confidence: "high", reason: "interview_keywords" };
  }

  if (hasAny(text, ASSESSMENT_RE) && !hasAny(text, SHORTLIST_RE)) {
    return { classification: "assessment", confidence: "high", reason: "assessment_keywords" };
  }

  if (hasAny(text, SHORTLIST_RE)) {
    const present = namePresentInText(text, input.studentNameTokens);
    const listComplete =
      hasAny(text, LIST_COMPLETE_RE) || looksEnumeratedNameList(input.bodyText || input.snippet);

    // Interview/assessment announced alongside shortlist → prefer that stage with name present.
    if (present) {
      if (hasAny(text, INTERVIEW_RE)) {
        return {
          classification: "interview",
          confidence: "high",
          namePresent: true,
          listComplete,
          reason: "shortlist_name_interview",
        };
      }
      if (hasAny(text, ASSESSMENT_RE)) {
        return {
          classification: "assessment",
          confidence: "high",
          namePresent: true,
          listComplete,
          reason: "shortlist_name_assessment",
        };
      }
      return {
        classification: "shortlist_present",
        confidence: "high",
        namePresent: true,
        listComplete,
        reason: "shortlist_name_match",
      };
    }

    if (input.studentNameTokens.length === 0) {
      return {
        classification: "unresolved",
        confidence: "low",
        namePresent: false,
        listComplete,
        reason: "shortlist_no_profile_name",
      };
    }

    if (!listComplete) {
      return {
        classification: "shortlist_absent",
        confidence: "low",
        namePresent: false,
        listComplete: false,
        reason: "shortlist_incomplete_no_name",
      };
    }

    return {
      classification: "shortlist_absent",
      confidence: "high",
      namePresent: false,
      listComplete: true,
      reason: "shortlist_complete_no_name",
    };
  }

  // Weak interview/assessment only in subject → low → unresolved
  if (/\b(interview|assessment|shortlist|offer|reject)/i.test(subject)) {
    return {
      classification: "unresolved",
      confidence: "low",
      reason: "weak_subject_only",
    };
  }

  return {
    classification: "unresolved",
    confidence: "low",
    reason: "no_rule_match",
  };
}

/** Rank for detecting upward classification changes on the same message. */
export function classificationRank(
  c: MailClassificationResult["classification"],
): number {
  switch (c) {
    case "unresolved":
      return 0;
    case "reschedule":
    case "cancel":
      return 1;
    case "shortlist_absent":
      return 2;
    case "shortlist_present":
      return 3;
    case "assessment":
      return 4;
    case "interview":
      return 5;
    case "offer_received":
      return 6;
    case "offer_accepted":
      return 7;
    case "offer_confirmed":
      return 8;
    case "rejection":
      return 9;
    default:
      return 0;
  }
}
