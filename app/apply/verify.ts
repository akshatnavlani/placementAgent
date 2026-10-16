import type { Config } from "../config.ts";
import { hasNotion, requireNotion, requirePlacementCredentials } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { getDrive, markApplied, markApplyChecked } from "../db/drive.ts";
import { loadBearerToken } from "../db/secret.ts";
import { NotionClient } from "../notion/client.ts";
import { syncDrive } from "../notion/sync.ts";
import type { PlacementClient } from "../placement/client.ts";
import type { TelegramClient } from "../telegram/client.ts";

export type VerifyLogger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
};

export type VerifyResult =
  | { kind: "applied"; company: string }
  | { kind: "not_applied"; company: string }
  | { kind: "not_new"; company: string; status: string | null }
  | { kind: "missing_drive" }
  | { kind: "no_token" }
  | { kind: "could_not_verify"; reason: string; company?: string };

export type VerifyDeps = {
  config: Config;
  db: DbClient;
  placement: PlacementClient;
  notion?: NotionClient;
  telegram?: TelegramClient;
  chatId?: string;
  fetch?: typeof globalThis.fetch;
  log?: VerifyLogger;
  now?: Date;
};

export function companyLabel(company: string | null | undefined): string {
  return company && company.trim() !== "" ? company.trim() : "Unknown company";
}

/**
 * Check platform apply status for one drive. Moves New → Applied only when applied: true.
 */
export async function verifyApplied(deps: VerifyDeps, driveId: string): Promise<VerifyResult> {
  const now = deps.now ?? new Date();
  const row = await getDrive(deps.db, driveId);
  if (!row) {
    return { kind: "missing_drive" };
  }
  const company = companyLabel(row.company_name);
  if (row.status !== "New") {
    return { kind: "not_new", company, status: row.status };
  }

  const secret = await loadBearerToken(deps.db);
  if (!secret.bearerToken) {
    return { kind: "no_token" };
  }

  const creds = requirePlacementCredentials(deps.config);
  const outcome = await deps.placement.checkApplyStatus(secret.bearerToken, creds.studentId, driveId);
  if (outcome.kind !== "ok") {
    const reason = outcome.kind === "network" ? outcome.message : outcome.kind;
    deps.log?.warn({ driveId, reason }, "checkApplyStatus failed");
    return { kind: "could_not_verify", reason: String(reason), company };
  }

  await markApplyChecked(deps.db, driveId, now);

  if (!outcome.data.applied) {
    return { kind: "not_applied", company };
  }

  const moved = await markApplied(deps.db, driveId, now);
  if (!moved) {
    // Race: already left New.
    const latest = await getDrive(deps.db, driveId);
    return { kind: "not_new", company, status: latest?.status ?? null };
  }

  await syncNotionAfterApplied(deps, driveId, now);
  deps.log?.info({ driveId, outcome: "applied" }, "drive marked Applied");
  return { kind: "applied", company };
}

async function syncNotionAfterApplied(deps: VerifyDeps, driveId: string, now: Date): Promise<void> {
  if (!hasNotion(deps.config) && !deps.notion) {
    return;
  }
  const row = await getDrive(deps.db, driveId);
  if (!row) {
    return;
  }
  try {
    const notionCfg = hasNotion(deps.config) ? requireNotion(deps.config) : null;
    const notion =
      deps.notion ??
      (notionCfg
        ? new NotionClient({
            token: notionCfg.token,
            fetch: deps.fetch,
            log: deps.log,
          })
        : null);
    if (!notion || !notionCfg) {
      return;
    }
    await syncDrive(
      {
        db: deps.db,
        notion,
        databaseId: notionCfg.databaseId,
        now,
        log: deps.log,
        telegram: deps.telegram,
        chatId: deps.chatId,
      },
      row,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "notion sync error";
    deps.log?.warn({ driveId, reason: message }, "notion sync after Applied failed");
  }
}

export function verifyReplyText(result: VerifyResult): string {
  switch (result.kind) {
    case "applied":
      return `Marked Applied: ${result.company}.`;
    case "not_applied":
      return "Platform shows no application.";
    case "could_not_verify":
      return "Could not verify. Try I applied again later.";
    case "no_token":
      return "Session is down. Wait for renewal, then try I applied again.";
    case "missing_drive":
      return "That drive is not in the tracker.";
    case "not_new":
      return `That drive is already ${result.status ?? "not New"}.`;
  }
}
