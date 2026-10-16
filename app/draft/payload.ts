import { normalizeAnswerLabel } from "../db/answer.ts";
import type { DriveRow } from "../db/drive.ts";
import type { DraftFacts } from "../profile/draftFacts.ts";

export type CustomField = {
  id: string | null;
  label: string;
  type: string | null;
  required: boolean;
  options: string[];
};

export type PreparePayload = {
  driveId: string;
  company: string;
  role: string;
  deadline: string | null;
  listExcerpt: Record<string, unknown>;
  detailExcerpt: Record<string, unknown> | null;
  pdfText: Record<string, string>;
  customFields: CustomField[];
  unansweredRequired: string[];
  canonicalLatex: string;
  profile: {
    studentId: string;
    platform: Record<string, unknown>;
    manual: DraftFacts["manual"];
  };
  approvedAnswers: Array<{ label: string; value: string }>;
  callbackUrl: string;
  /** Same value as Render DRAFT_CALLBACK_SECRET — Cursor Automations have no env UI. */
  callbackSecret: string;
};

const SENSITIVE_KEY = /password|bearer|token|secret|authorization|otp|refresh/i;

function sanitizeRecord(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 4) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(key)) {
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = sanitizeRecord(value as Record<string, unknown>, depth + 1);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? sanitizeRecord(item as Record<string, unknown>, depth + 1)
          : item,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

export function extractCustomFields(source: Record<string, unknown> | null): CustomField[] {
  if (!source) {
    return [];
  }
  const raw = source.customFields;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: CustomField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const field = item as Record<string, unknown>;
    const label = pickString(field.label, field.name, field.fieldName);
    if (!label) {
      continue;
    }
    const optionsRaw = field.options;
    const options = Array.isArray(optionsRaw)
      ? optionsRaw.filter((o): o is string => typeof o === "string")
      : [];
    out.push({
      id: typeof field.id === "string" ? field.id : null,
      label,
      type: typeof field.type === "string" ? field.type : null,
      required: field.required === true || field.required === "true",
      options,
    });
  }
  return out;
}

export function unansweredRequiredLabels(
  fields: CustomField[],
  approvedAnswers: Array<{ label: string; value: string }>,
): string[] {
  const have = new Set(approvedAnswers.map((a) => normalizeAnswerLabel(a.label)));
  const missing: string[] = [];
  for (const field of fields) {
    if (!field.required) {
      continue;
    }
    if (!have.has(normalizeAnswerLabel(field.label))) {
      missing.push(field.label);
    }
  }
  return missing;
}

export function buildPreparePayload(input: {
  drive: DriveRow;
  facts: DraftFacts;
  callbackUrl: string;
  callbackSecret: string;
}): PreparePayload {
  const { drive, facts, callbackUrl, callbackSecret } = input;
  if (!facts.canonicalLatex || facts.canonicalLatex.trim() === "") {
    throw new Error("canonical latex required");
  }
  if (!callbackSecret || callbackSecret.length < 32) {
    throw new Error("callback secret required");
  }
  const detail = drive.raw_detail;
  const list = drive.raw_list;
  const customFields = extractCustomFields(detail ?? list);
  const company =
    pickString(drive.company_name, list.companyName, detail?.companyName) ?? "Unknown company";
  const role =
    pickString(drive.event_name, list.eventName, detail?.eventName) ?? "Role not listed";

  return {
    driveId: drive.id,
    company,
    role,
    deadline: drive.deadline,
    listExcerpt: sanitizeRecord(list),
    detailExcerpt: detail ? sanitizeRecord(detail) : null,
    pdfText: { ...drive.pdf_text },
    customFields,
    unansweredRequired: unansweredRequiredLabels(customFields, facts.answers),
    canonicalLatex: facts.canonicalLatex,
    profile: {
      studentId: facts.studentId,
      platform: facts.platformForDraft,
      manual: facts.manual,
    },
    approvedAnswers: facts.answers,
    callbackUrl,
    callbackSecret,
  };
}

/** Safe keys for logging — never log latex, answers, or callbackSecret. */
export function preparePayloadLogKeys(payload: PreparePayload): Record<string, unknown> {
  return {
    driveId: payload.driveId,
    company: payload.company,
    role: payload.role,
    customFieldCount: payload.customFields.length,
    unansweredRequiredCount: payload.unansweredRequired.length,
    approvedAnswerCount: payload.approvedAnswers.length,
    latexChars: payload.canonicalLatex.length,
    pdfUrlCount: Object.keys(payload.pdfText).length,
    callbackUrl: payload.callbackUrl,
    hasCallbackSecret: Boolean(payload.callbackSecret),
    keys: Object.keys(payload).sort(),
  };
}
