import type { Config } from "../config.ts";
import { hasCursorDrafter, requireCursorDrafter } from "../config.ts";
import { listApprovedReusable } from "../db/answer.ts";
import type { DbClient } from "../db/client.ts";
import { failDraft, insertPendingDraft } from "../db/draft.ts";
import { getDrive, setDraftStatus } from "../db/drive.ts";
import { loadFullProfile } from "../db/profile.ts";
import { buildDraftFacts, profileReadyForDraft } from "../profile/draftFacts.ts";
import type { TelegramClient } from "../telegram/client.ts";
import { buildPreparePayload, preparePayloadLogKeys } from "./payload.ts";
import { postCursorWebhook } from "./webhook.ts";

export type PrepareResult =
  | { kind: "preparing"; driveId: string }
  | { kind: "already_pending"; driveId: string }
  | { kind: "missing_drive" }
  | { kind: "missing_latex" }
  | { kind: "not_configured" }
  | { kind: "no_profile" }
  | { kind: "webhook_failed"; reason: string };

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
  }
}

/**
 * Start a Cursor draft for one drive. Idempotent while pending.
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

  if (!hasCursorDrafter(deps.config)) {
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

  const cursor = requireCursorDrafter(deps.config);
  const answers = await listApprovedReusable(deps.db);
  const facts = buildDraftFacts(profile, answers);
  const callbackUrl = `${cursor.publicBaseUrl}/draft/callback`;
  const payload = buildPreparePayload({
    drive,
    facts,
    callbackUrl,
    callbackSecret: cursor.callbackSecret,
  });

  await setDraftStatus(deps.db, driveId, "pending", now);
  await insertPendingDraft(deps.db, driveId, now);

  deps.log?.info?.(preparePayloadLogKeys(payload), "prepare webhook dispatch");

  const posted = await postCursorWebhook({
    url: cursor.webhookUrl,
    secret: cursor.webhookSecret,
    payload,
    fetch: deps.fetch,
    log: deps.log,
  });

  if (!posted.ok) {
    await setDraftStatus(deps.db, driveId, "failed", now);
    await failDraft(deps.db, driveId, posted.reason, now);
    deps.log?.warn?.({ driveId, reason: posted.reason }, "prepare webhook failed");
    return { kind: "webhook_failed", reason: posted.reason };
  }

  return { kind: "preparing", driveId };
}
