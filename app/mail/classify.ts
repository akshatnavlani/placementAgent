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
  /** Optional From header for sender priors. */
  from?: string;
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

/** Campus app blasts — poll owns discovery. */
export const UPO_SUBJECT_RE =
  /upcoming\s+placement\s+opportunity\s*[:|]?\s*.+?\s*[—–-]\s*check\s+details/i;

const SYSTEM_IGNORE_RE = [
  /\bstudent\s+login\s+otp\b/i,
  /\bpesu\s+placement\s+app\b/i,
  /\bcgpa\s+has\s+been\s+updated\b/i,
  /\baccount\s+password\b/i,
  /\byour\s+otp\s+is\b/i,
];

const CANCEL_RE = [
  /\bcancell?ed\b/i,
  /\bcancellation\b/i,
  /\bdrive\s+cancelled\b/i,
  /\bevent\s+cancelled\b/i,
];
const RESCHEDULE_RE = [
  /\breschedul/i,
  /\bpostponed\b/i,
  /\bdrive\s+stands\s+postponed\b/i,
  /\brevised\s+dates?\s+will\s+be\s+communicated\b/i,
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
/** Strong PESU-cell offer language. */
const OFFER_STRONG_BODY_RE = [
  /\backnowledge\s+the\s+offer\s+acceptance\b/i,
  /\ball\s+the\s+offered\s+students\s+are\s+hereby\s+informed\b/i,
];
const OFFER_STRONG_SUBJECT_RE = [
  /\bfinal\s+selects?\b/i,
  /\bchosen\s+ones\b/i,
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
  /\bcodecademy\b/i,
  /\bleetcode\b/i,
];
const REJECTION_RE = [
  /\bcandidature\s+(?:has\s+been\s+)?rejected\b/i,
  /\bidv\s+rejected\b/i,
  /\bnot\s+shortlisted\b/i,
  /\bregret\s+to\s+inform\b/i,
  /\bwe\s+regret\b/i,
  /\bunfortunately[\s\S]{0,60}\b(?:not\s+selected|rejected|not\s+shortlisted)\b/i,
  /\byou\s+(?:have\s+)?(?:been\s+)?rejected\b/i,
  /\bapplication\s+(?:has\s+been\s+)?rejected\b/i,
];
/** No bare /\binterview\b/ — that false-fires on UPO JD text. */
const INTERVIEW_RE = [
  /\btechnical\s+interview\b/i,
  /\bhr\s+(?:round|interview)\b/i,
  /\binterview\s+(?:schedule|scheduled|invite|invitation|round|tomorrow|timings?)\b/i,
  /\bscheduled\s+(?:an?\s+)?interview\b/i,
  /\bvirtual\s+interview\b/i,
  /\bf2f\s+interviews?\b/i,
  /\bgd\s+schedule\b/i,
  /\bgroup\s+discussion\b/i,
  /\bvoa\b/i,
  /\bcase\s+discussion\b/i,
  /\breport\s+to\s+(?:the\s+)?placement\s+office\b/i,
  /\bshortlist\s+for\s+the\s+interview\b/i,
  /\binterview\s+shortlist\b/i,
];
const ASSESSMENT_RE = [
  /\bassessment\s+invitation\b/i,
  /\bassessment\s+completed\b/i,
  /\bonline\s+assessment\b/i,
  /\b\boa\b/i,
  /\bhackerrank\b/i,
  /\bhackerearth\b/i,
  /\bassessment\s+(?:link|test|round|shortlist)\b/i,
  /\btest\s+link\b/i,
  /\btest\s+invite\b/i,
  /\bwritten\s+test\b/i,
  /\bcoding\s+(?:test|assessment)\b/i,
  /\bonline\s+test\b/i,
  /\bthanks\s+for\s+taking\b[\s\S]{0,40}\btest\b/i,
  /\bbehavioural\s+assess/i,
  /\bshortlist\s+for\s+the\s+online\s+assessment\b/i,
];
const SHORTLIST_RE = [
  /\bshortlist(?:ed|ing)?\b/i,
  /\bhas\s+shared\s+the\s+shortlist\b/i,
  /\ball\s+the\s+shortlisted\s+students\b/i,
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
    const cleaned = line.replace(/^\d+[\).:\-\s]+/, "").replace(/^[-*•]\s+/, "");
    if (/^[A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+){1,3}$/.test(cleaned)) {
      nameLines += 1;
    }
  }
  return nameLines >= 3;
}

export function isCampusUpoSubject(subject: string): boolean {
  return UPO_SUBJECT_RE.test(subject);
}

export function isSystemIgnoreMail(subject: string, body: string): boolean {
  const hay = `${subject}\n${body}`;
  return SYSTEM_IGNORE_RE.some((re) => re.test(hay));
}

/**
 * Ordered rule classifier. First high-confidence win.
 * Low confidence → unresolved (never auto-reject on weak signals).
 */
export function classifyRecruitmentMail(input: ClassifyInput): MailClassificationResult {
  const text = combinedText(input);
  const subject = input.subject;

  // UPO / system — never actionable stage mail.
  if (isCampusUpoSubject(subject)) {
    return { classification: "unresolved", confidence: "low", reason: "campus_upo_blast" };
  }
  if (isSystemIgnoreMail(subject, text)) {
    return { classification: "unresolved", confidence: "low", reason: "system_noise" };
  }

  if (hasAny(text, CANCEL_RE) && !hasAny(text, RESCHEDULE_RE)) {
    return { classification: "cancel", confidence: "high", reason: "cancel_keywords" };
  }
  if (hasAny(text, RESCHEDULE_RE)) {
    return { classification: "reschedule", confidence: "high", reason: "reschedule_keywords" };
  }

  // Offer subtypes — strong PESU phrases first; weak keywords only as offer_received.
  if (!hasAny(text, OFFER_NOISE_RE)) {
    if (hasAny(text, OFFER_CONFIRMED_RE)) {
      return { classification: "offer_confirmed", confidence: "high", reason: "offer_confirmation" };
    }
    if (hasAny(text, OFFER_STRONG_BODY_RE)) {
      return { classification: "offer_received", confidence: "high", reason: "offer_ack_body" };
    }
    if (hasAny(subject, OFFER_STRONG_SUBJECT_RE) && hasAny(text, OFFER_RE)) {
      return { classification: "offer_received", confidence: "high", reason: "final_selects_offer" };
    }
    if (hasAny(text, OFFER_ACCEPT_YOU_RE) && hasAny(text, OFFER_RE)) {
      return { classification: "offer_accepted", confidence: "high", reason: "student_acceptance" };
    }
    if (hasAny(text, OFFER_RE)) {
      // Weak keyword offer — still classified for storage; stage map will not Accepted.
      return { classification: "offer_received", confidence: "high", reason: "offer_keywords_weak" };
    }
  }

  if (hasAny(text, REJECTION_RE)) {
    return { classification: "rejection", confidence: "high", reason: "rejection_keywords" };
  }

  // Shortlist + interview/OA in subject → stage before generic shortlist / bare patterns.
  if (hasAny(text, SHORTLIST_RE)) {
    const present = namePresentInText(text, input.studentNameTokens);
    const listComplete =
      hasAny(text, LIST_COMPLETE_RE) || looksEnumeratedNameList(input.bodyText || input.snippet);

    if (
      /\bshortlist\s+for\s+the\s+interview\b/i.test(text) ||
      /\binterview\s+shortlist\b/i.test(text) ||
      (hasAny(subject, [/interview/i]) && hasAny(subject, [/shortlist/i]))
    ) {
      return {
        classification: "interview",
        confidence: "high",
        namePresent: present,
        listComplete,
        reason: "shortlist_interview_qualified",
      };
    }
    if (
      /\bshortlist\s+for\s+the\s+online\s+assessment\b/i.test(text) ||
      /\bassessment\s+shortlist\b/i.test(text) ||
      (hasAny(subject, [/assessment|online\s+test|written\s+test|\boa\b/i]) &&
        hasAny(subject, [/shortlist/i]))
    ) {
      return {
        classification: "assessment",
        confidence: "high",
        namePresent: present,
        listComplete,
        reason: "shortlist_assessment_qualified",
      };
    }

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

    // Company shortlist from PESU cell without name in body (xlsx attach) — still notify later
    // as shortlist_present leave Applied when company matches; do not high-confidence reject.
    if (/\bhas\s+shared\s+the\s+shortlist\b/i.test(text) || /\ball\s+the\s+shortlisted\s+students\b/i.test(text)) {
      return {
        classification: "shortlist_present",
        confidence: "high",
        namePresent: false,
        listComplete: false,
        reason: "pesu_cell_shortlist",
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

  if (hasAny(text, INTERVIEW_RE)) {
    return { classification: "interview", confidence: "high", reason: "interview_keywords" };
  }

  if (hasAny(text, ASSESSMENT_RE)) {
    return { classification: "assessment", confidence: "high", reason: "assessment_keywords" };
  }

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

/** Reasons that may advance Notion to Accepted. */
export function isStrongOfferReason(reason: string): boolean {
  return (
    reason === "offer_confirmation" ||
    reason === "student_acceptance" ||
    reason === "offer_ack_body" ||
    reason === "final_selects_offer"
  );
}
