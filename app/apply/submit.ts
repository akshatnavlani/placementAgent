import type { Config } from "../config.ts";
import { requirePlacementCredentials } from "../config.ts";
import { listApprovedReusable, normalizeAnswerLabel } from "../db/answer.ts";
import type { DbClient } from "../db/client.ts";
import { getLatestDraft } from "../db/draft.ts";
import { getDrive, setDetail } from "../db/drive.ts";
import { loadPlatformProfile } from "../db/profile.ts";
import { loadBearerToken } from "../db/secret.ts";
import { compileLatexToPdf } from "../draft/compile.ts";
import { assertDropdownValue, sanitizeFilename } from "../draft/formatAnswers.ts";
import {
  extractCustomFields,
  unansweredRequiredFields,
  type CustomField,
} from "../draft/payload.ts";
import { countPdfPages } from "../pdf/pageCount.ts";
import type { PlacementClient } from "../placement/client.ts";
import { companyLabel, verifyApplied, type VerifyDeps, type VerifyResult } from "./verify.ts";

export type SubmitResult =
  | VerifyResult
  | { kind: "missing_company_username"; company: string }
  | { kind: "missing_draft" }
  | { kind: "pdf_failed"; reason: string }
  | { kind: "missing_answers"; labels: string[] }
  | { kind: "invalid_answers"; reason: string }
  | { kind: "upload_failed"; reason: string }
  | { kind: "apply_rejected"; reason: string; status?: number }
  | { kind: "apply_failed"; reason: string };

export type SubmitDeps = VerifyDeps & {
  compile?: Parameters<typeof compileLatexToPdf>[2];
  countPages?: typeof countPdfPages;
};

function studentFullName(platform: Record<string, unknown> | null): string {
  if (!platform) {
    return "";
  }
  for (const key of ["fullName", "name", "studentName"]) {
    const v = platform[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return "";
}

function mergeAnswers(
  draftAnswers: Array<{ label: string; value: string }>,
  bank: Array<{ label_display: string; value: string }>,
): Array<{ label: string; value: string }> {
  const byNorm = new Map<string, { label: string; value: string }>();
  for (const a of bank) {
    const key = normalizeAnswerLabel(a.label_display);
    if (!key || !a.value.trim()) {
      continue;
    }
    byNorm.set(key, { label: a.label_display, value: a.value });
  }
  // Draft answers win on conflict (drive-specific).
  for (const a of draftAnswers) {
    const key = normalizeAnswerLabel(a.label);
    if (!key || !a.value.trim()) {
      continue;
    }
    byNorm.set(key, { label: a.label, value: a.value });
  }
  return [...byNorm.values()];
}

/** Exported for tests — keys only by field id (or label when id missing). */
export function buildCustomFieldResponses(
  fields: CustomField[],
  answers: Array<{ label: string; value: string }>,
): Record<string, string> {
  const byNorm = new Map(
    answers.map((a) => [normalizeAnswerLabel(a.label), a.value] as const),
  );
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = byNorm.get(normalizeAnswerLabel(field.label));
    if (value === undefined) {
      continue;
    }
    const key = field.id?.trim() || field.label;
    out[key] = value;
  }
  return out;
}

function validateAnswers(
  fields: CustomField[],
  answers: Array<{ label: string; value: string }>,
): { ok: true } | { ok: false; kind: "missing_answers"; labels: string[] } | { ok: false; kind: "invalid_answers"; reason: string } {
  const missing = unansweredRequiredFields(fields, answers);
  if (missing.length > 0) {
    return { ok: false, kind: "missing_answers", labels: missing.map((f) => f.label) };
  }
  const byNorm = new Map(
    answers.map((a) => [normalizeAnswerLabel(a.label), a.value] as const),
  );
  for (const field of fields) {
    const value = byNorm.get(normalizeAnswerLabel(field.label));
    if (value === undefined) {
      continue;
    }
    const check = assertDropdownValue(field, value);
    if (!check.ok) {
      return { ok: false, kind: "invalid_answers", reason: `${field.label}: ${check.reason}` };
    }
  }
  return { ok: true };
}

function httpReason(status: number, message?: string): string {
  const base = `http ${status}`;
  const msg = message?.trim();
  if (!msg) {
    return base;
  }
  return `${base}: ${msg.slice(0, 200)}`;
}

/**
 * Upload resume PDF, POST apply, then verify via checkApplyStatus.
 */
export async function submitApplication(deps: SubmitDeps, driveId: string): Promise<SubmitResult> {
  let drive = await getDrive(deps.db, driveId);
  if (!drive) {
    return { kind: "missing_drive" };
  }
  const company = companyLabel(drive.company_name);
  if (drive.status !== "New") {
    return { kind: "not_new", company, status: drive.status };
  }
  const companyUsername = drive.company_username?.trim() ?? "";
  if (!companyUsername) {
    return { kind: "missing_company_username", company };
  }

  const draft = await getLatestDraft(deps.db, driveId);
  if (!draft || draft.status !== "ready" || !draft.latex?.trim()) {
    return { kind: "missing_draft" };
  }

  const secret = await loadBearerToken(deps.db);
  if (!secret.bearerToken) {
    return { kind: "no_token" };
  }

  const creds = requirePlacementCredentials(deps.config);
  const profile = await loadPlatformProfile(deps.db);
  const fullName = studentFullName(profile?.platform ?? null) || creds.studentId;

  let fields = extractCustomFields(drive.raw_detail ?? drive.raw_list);
  if (fields.length === 0 && !drive.raw_detail) {
    const detail = await deps.placement.getEventDetails(secret.bearerToken, driveId);
    if (detail.kind === "ok") {
      await setDetail(deps.db, driveId, detail.data as Record<string, unknown>);
      drive = (await getDrive(deps.db, driveId)) ?? drive;
      fields = extractCustomFields(drive.raw_detail ?? drive.raw_list);
    }
  }

  const bank = await listApprovedReusable(deps.db);
  const answers = mergeAnswers(
    draft.answers,
    bank.map((a) => ({ label_display: a.label_display, value: a.value })),
  );
  const validated = validateAnswers(fields, answers);
  if (!validated.ok) {
    if (validated.kind === "missing_answers") {
      return { kind: "missing_answers", labels: validated.labels };
    }
    return { kind: "invalid_answers", reason: validated.reason };
  }

  const compiled = await compileLatexToPdf(draft.latex, driveId, {
    ...deps.compile,
    fetch: deps.fetch ?? deps.compile?.fetch,
  });
  if (!compiled.ok) {
    return { kind: "pdf_failed", reason: compiled.reason };
  }

  const countPages = deps.countPages ?? countPdfPages;
  const pages = await countPages(compiled.pdf);
  if (pages.ok && pages.pages !== 1) {
    return { kind: "pdf_failed", reason: `resume is ${pages.pages} pages (need 1)` };
  }
  if (!pages.ok) {
    deps.log?.warn?.({ driveId, reason: pages.reason }, "pdf page count failed; applying anyway");
  }

  const filename = `${sanitizeFilename(company)}-resume.pdf`;
  const uploaded = await deps.placement.uploadEventResume(secret.bearerToken, {
    studentID: creds.studentId,
    eventID: driveId,
    pdf: compiled.pdf,
    originalFilename: filename,
  });
  if (uploaded.kind !== "ok") {
    const reason =
      uploaded.kind === "invalid"
        ? uploaded.reason
        : uploaded.kind === "network"
          ? uploaded.message
          : uploaded.kind === "http"
            ? httpReason(uploaded.status, uploaded.message)
            : uploaded.kind;
    return { kind: "upload_failed", reason: String(reason) };
  }

  const customFieldResponses = buildCustomFieldResponses(fields, answers);
  deps.log?.info?.(
    { driveId, responseKeys: Object.keys(customFieldResponses), fieldCount: fields.length },
    "apply customFieldResponses",
  );
  const applied = await deps.placement.applyToEvent(secret.bearerToken, {
    studentID: creds.studentId,
    fullName,
    eventID: driveId,
    eventName: drive.event_name?.trim() || "Drive",
    companyUsername,
    customFieldResponses,
  });
  if (applied.kind === "http") {
    deps.log?.warn?.(
      {
        driveId,
        status: applied.status,
        message: applied.message,
        responseKeys: Object.keys(customFieldResponses),
      },
      "apply http error",
    );
    return {
      kind: "apply_rejected",
      reason: httpReason(applied.status, applied.message),
      status: applied.status,
    };
  }
  if (applied.kind !== "ok") {
    const reason =
      applied.kind === "invalid"
        ? applied.reason
        : applied.kind === "network"
          ? applied.message
          : applied.kind;
    return { kind: "apply_failed", reason: String(reason) };
  }

  return verifyApplied(deps, driveId);
}

export function submitReplyText(result: SubmitResult): string {
  switch (result.kind) {
    case "applied":
      return `Applied: ${result.company}.`;
    case "not_applied":
      return "Submitted, but platform still shows no application. Try Apply again shortly.";
    case "missing_draft":
      return "Prepare a draft first (need answers + resume PDF).";
    case "missing_company_username":
      return `Cannot apply to ${result.company}: missing companyUsername on the drive.`;
    case "pdf_failed":
      return `Could not compile PDF: ${result.reason}`;
    case "missing_answers":
      return `Need answers before Apply: ${result.labels.join("; ")}. Tap Prepare.`;
    case "invalid_answers":
      return `Invalid answers: ${result.reason}`;
    case "upload_failed":
      return `Resume upload failed: ${result.reason}`;
    case "apply_rejected":
      return result.status === 409
        ? "Already applied or scheduling conflict (409)."
        : result.status === 403
          ? "Not eligible to apply (403)."
          : `Apply rejected: ${result.reason}`;
    case "apply_failed":
      return `Apply failed: ${result.reason}`;
    case "could_not_verify":
      return "Submitted, but could not verify yet. Try Apply again later.";
    case "no_token":
      return "Session is down. Wait for renewal, then try Apply again.";
    case "missing_drive":
      return "That drive is not in the tracker.";
    case "not_new":
      return `That drive is already ${result.status ?? "not New"}.`;
  }
}
