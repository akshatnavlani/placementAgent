import type { Config } from "../config.ts";
import { requirePlacementCredentials } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { getLatestDraft } from "../db/draft.ts";
import { getDrive } from "../db/drive.ts";
import { loadPlatformProfile } from "../db/profile.ts";
import { loadBearerToken } from "../db/secret.ts";
import { compileLatexToPdf } from "../draft/compile.ts";
import { extractCustomFields } from "../draft/payload.ts";
import { sanitizeFilename } from "../draft/formatAnswers.ts";
import { normalizeAnswerLabel } from "../db/answer.ts";
import type { PlacementClient } from "../placement/client.ts";
import { companyLabel, verifyApplied, type VerifyDeps, type VerifyResult } from "./verify.ts";

export type SubmitResult =
  | VerifyResult
  | { kind: "missing_company_username"; company: string }
  | { kind: "missing_draft" }
  | { kind: "pdf_failed"; reason: string }
  | { kind: "upload_failed"; reason: string }
  | { kind: "apply_rejected"; reason: string; status?: number }
  | { kind: "apply_failed"; reason: string };

export type SubmitDeps = VerifyDeps & {
  compile?: Parameters<typeof compileLatexToPdf>[2];
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

function buildCustomFieldResponses(
  driveRaw: Record<string, unknown> | null,
  answers: Array<{ label: string; value: string }>,
): Record<string, string> {
  const fields = extractCustomFields(driveRaw);
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
  // Also include any leftover by display label for platforms that key on label.
  for (const a of answers) {
    if (!Object.values(out).includes(a.value)) {
      out[a.label] = a.value;
    }
  }
  return out;
}

/**
 * Upload resume PDF, POST apply, then verify via checkApplyStatus.
 */
export async function submitApplication(deps: SubmitDeps, driveId: string): Promise<SubmitResult> {
  const drive = await getDrive(deps.db, driveId);
  if (!drive) {
    return { kind: "missing_drive" };
  }
  const company = companyLabel(drive.company_name);
  if (drive.status !== "New") {
    return { kind: "not_new", company, status: drive.status };
  }
  if (!drive.company_username?.trim()) {
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

  const compiled = await compileLatexToPdf(draft.latex, driveId, {
    ...deps.compile,
    fetch: deps.fetch ?? deps.compile?.fetch,
  });
  if (!compiled.ok) {
    return { kind: "pdf_failed", reason: compiled.reason };
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
            ? `http ${uploaded.status}`
            : uploaded.kind;
    return { kind: "upload_failed", reason: String(reason) };
  }

  const customFieldResponses = buildCustomFieldResponses(
    drive.raw_detail ?? drive.raw_list,
    draft.answers,
  );
  const applied = await deps.placement.applyToEvent(secret.bearerToken, {
    studentID: creds.studentId,
    fullName,
    eventID: driveId,
    eventName: drive.event_name?.trim() || "Drive",
    companyUsername: drive.company_username.trim(),
    customFieldResponses,
  });
  if (applied.kind === "http") {
    return {
      kind: "apply_rejected",
      reason: `http ${applied.status}`,
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
