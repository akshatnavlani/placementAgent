import type { Config } from "../config.ts";
import { hasDrafter, requireDrafter } from "../config.ts";
import { hydrateAnswersFromProfile, listApprovedReusable, preseedFromProfile } from "../db/answer.ts";
import type { DbClient } from "../db/client.ts";
import { failDraft, getLatestDraft, insertPendingDraft } from "../db/draft.ts";
import { getDrive, setDraftStatus } from "../db/drive.ts";
import { loadFullProfile } from "../db/profile.ts";
import { buildDraftFacts, profileReadyForDraft } from "../profile/draftFacts.ts";
import type { TelegramClient } from "../telegram/client.ts";
import { postClaudeRoutineFire } from "./claudeFire.ts";
import { deliverReadyDraft } from "./deliver.ts";
import {
  buildPreparePayload,
  extractCustomFields,
  preparePayloadLogKeys,
  unansweredRequiredFields,
  type CustomField,
} from "./payload.ts";
import { postCursorWebhook } from "./webhook.ts";

export type PrepareResult =
  | { kind: "preparing"; driveId: string }
  | { kind: "already_pending"; driveId: string }
  | { kind: "missing_drive" }
  | { kind: "missing_latex" }
  | { kind: "not_configured" }
  | { kind: "no_profile" }
  | { kind: "webhook_failed"; reason: string }
  | { kind: "need_answers"; driveId: string; fields: CustomField[] }
  | { kind: "redelivered"; driveId: string; pdf: boolean }
  | { kind: "redeliver_failed"; driveId: string; reason: string };

export type PrepareDeps = {
  config: Config;
  db: DbClient;
  telegram: TelegramClient;
  chatId: string;
  fetch?: typeof globalThis.fetch;
  log?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
  now?: Date;
  /** When true, skip need_answers gate (after ask flow completed). */
  skipAskGate?: boolean;
};

export function prepareReplyText(result: PrepareResult): string {
  switch (result.kind) {
    case "preparing":
      return "preparing.";
    case "already_pending":
      return "Already preparing.";
    case "missing_drive":
      return "That drive is not in the tracker.";
    case "missing_latex":
      return "Send /profile and upload your LaTeX resume first.";
    case "not_configured":
      return "Drafter not configured.";
    case "no_profile":
      return "No platform profile yet. Wait for a successful poll/login.";
    case "webhook_failed":
      return "Draft failed. Tap Prepare again.";
    case "need_answers":
      return "Need a few answers before preparing.";
    case "redelivered":
      return result.pdf ? "Draft re-sent (including PDF)." : "Draft re-sent.";
    case "redeliver_failed":
      return `Could not re-send draft: ${result.reason}`;
  }
}

/**
 * Start a draft agent run for one drive. Idempotent while pending.
 * Redelivers an undelivered ready draft without a new agent run.
 */
export async function prepareDrive(deps: PrepareDeps, driveId: string): Promise<PrepareResult> {
  const now = deps.now ?? new Date();
  const drive = await getDrive(deps.db, driveId);
  if (!drive) {
    return { kind: "missing_drive" };
  }
  if (drive.draft_status === "pending") {
    return { kind: "already_pending", driveId };
  }

  if (!hasDrafter(deps.config)) {
    return { kind: "not_configured" };
  }

  const profile = await loadFullProfile(deps.db);
  if (!profile) {
    return { kind: "no_profile" };
  }
  const ready = profileReadyForDraft(profile);
  if (!ready.ok) {
    return { kind: "missing_latex" };
  }

  // Redeliver ready-but-undelivered without a new agent run.
  if (drive.draft_status === "ready") {
    const latest = await getLatestDraft(deps.db, driveId);
    if (latest?.status === "ready" && latest.latex && !latest.delivered_at) {
      const delivered = await deliverReadyDraft(
        {
          config: deps.config,
          db: deps.db,
          telegram: deps.telegram,
          fetch: deps.fetch,
          log: deps.log,
          now,
        },
        driveId,
      );
      if (delivered.kind === "delivered" || delivered.kind === "already_delivered") {
        return {
          kind: "redelivered",
          driveId,
          pdf: delivered.kind === "delivered" ? delivered.pdf : false,
        };
      }
      return {
        kind: "redeliver_failed",
        driveId,
        reason: delivered.kind === "partial" ? delivered.reason : delivered.kind,
      };
    }
  }

  const fields = extractCustomFields(drive.raw_detail ?? drive.raw_list);
  // Refresh answer bank from profile (awards/certs etc.) before the ask gate.
  await preseedFromProfile(deps.db, profile);
  await hydrateAnswersFromProfile(
    deps.db,
    profile,
    fields.filter((f) => f.required).map((f) => f.label),
  );

  const answers = await listApprovedReusable(deps.db);
  const missing = unansweredRequiredFields(
    fields,
    answers.map((a) => ({ label: a.label_display, value: a.value })),
  );
  if (!deps.skipAskGate && missing.length > 0) {
    return { kind: "need_answers", driveId, fields: missing };
  }

  const drafter = requireDrafter(deps.config);
  const facts = buildDraftFacts(profile, answers);
  const callbackUrl = `${drafter.publicBaseUrl}/draft/callback`;
  const payload = buildPreparePayload({
    drive,
    facts,
    callbackUrl,
    callbackSecret: drafter.callbackSecret,
  });

  await setDraftStatus(deps.db, driveId, "pending", now);

  deps.log?.info?.(
    { ...preparePayloadLogKeys(payload), provider: drafter.provider },
    "prepare dispatch",
  );

  let posted: { ok: true } | { ok: false; reason: string };
  if (drafter.provider === "claude_code") {
    await insertPendingDraft(deps.db, driveId, now, payload);
    const payloadUrl = `${drafter.publicBaseUrl}/draft/prepare-payload?driveId=${encodeURIComponent(driveId)}`;
    posted = await postClaudeRoutineFire({
      fireUrl: drafter.fireUrl,
      fireToken: drafter.fireToken,
      pointer: {
        driveId,
        company: payload.company,
        role: payload.role,
        payloadUrl,
        callbackUrl,
        callbackSecret: drafter.callbackSecret,
      },
      fetch: deps.fetch,
      log: deps.log,
    });
  } else {
    await insertPendingDraft(deps.db, driveId, now);
    posted = await postCursorWebhook({
      url: drafter.webhookUrl,
      secret: drafter.webhookSecret,
      payload,
      fetch: deps.fetch,
      log: deps.log,
    });
  }

  if (!posted.ok) {
    await setDraftStatus(deps.db, driveId, "failed", now);
    await failDraft(deps.db, driveId, posted.reason, now);
    deps.log?.warn?.(
      { driveId, reason: posted.reason, provider: drafter.provider },
      "prepare dispatch failed",
    );
    return { kind: "webhook_failed", reason: posted.reason };
  }

  return { kind: "preparing", driveId };
}
