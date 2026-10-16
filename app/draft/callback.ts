import { z } from "zod";
import type { Config } from "../config.ts";
import { hasTelegram, requireDraftCallbackSecret, requireTelegram } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { completeDraftReady, failDraft } from "../db/draft.ts";
import { getDrive, setDraftStatus } from "../db/drive.ts";
import { TelegramClient } from "../telegram/client.ts";

export const draftCallbackBodySchema = z.object({
  driveId: z.string().min(1),
  ok: z.boolean().optional(),
  latex: z.string().optional().default(""),
  answers: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional()
    .default([]),
  error: z.string().optional(),
});

export type DraftCallbackBody = z.infer<typeof draftCallbackBodySchema>;

export type CallbackResult =
  | { status: 200; body: { ok: true; status: string } }
  | { status: 400 | 404 | 409; body: { error: string } };

export async function handleDraftCallback(input: {
  config: Config;
  db: DbClient;
  body: DraftCallbackBody;
  fetch?: typeof globalThis.fetch;
  log?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
  now?: Date;
}): Promise<CallbackResult> {
  const now = input.now ?? new Date();
  const drive = await getDrive(input.db, input.body.driveId);
  if (!drive) {
    return { status: 404, body: { error: "unknown_drive" } };
  }
  if (drive.draft_status !== "pending") {
    return { status: 409, body: { error: "not_pending" } };
  }

  const failed = input.body.ok === false || Boolean(input.body.error);
  if (failed) {
    const reason = input.body.error?.trim() || "agent reported failure";
    await setDraftStatus(input.db, drive.id, "failed", now);
    await failDraft(input.db, drive.id, reason, now);
    await notifyTelegram(input, `Draft failed for ${drive.company_name ?? drive.id}: ${reason}`);
    return { status: 200, body: { ok: true, status: "failed" } };
  }

  const latex = (input.body.latex ?? "").trim();
  if (!latex) {
    await setDraftStatus(input.db, drive.id, "failed", now);
    await failDraft(input.db, drive.id, "empty latex", now);
    await notifyTelegram(input, `Draft failed for ${drive.company_name ?? drive.id}: empty latex`);
    return { status: 400, body: { error: "empty_latex" } };
  }

  const updated = await completeDraftReady(input.db, drive.id, latex, input.body.answers ?? [], now);
  if (!updated) {
    return { status: 409, body: { error: "not_pending" } };
  }
  await setDraftStatus(input.db, drive.id, "ready", now);
  const company = drive.company_name?.trim() || drive.id;
  await notifyTelegram(
    input,
    `Draft ready for ${company}. Delivery in a later update.`,
  );
  input.log?.info?.({ driveId: drive.id, answerCount: input.body.answers?.length ?? 0 }, "draft ready");
  return { status: 200, body: { ok: true, status: "ready" } };
}

async function notifyTelegram(
  input: {
    config: Config;
    fetch?: typeof globalThis.fetch;
    log?: { warn?: (obj: Record<string, unknown>, msg?: string) => void };
  },
  text: string,
): Promise<void> {
  if (!hasTelegram(input.config)) {
    return;
  }
  try {
    const tg = requireTelegram(input.config);
    const client = new TelegramClient({
      botToken: tg.botToken,
      fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
    });
    await client.sendMessage(tg.chatId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "telegram error";
    input.log?.warn?.({ reason: message }, "draft callback telegram failed");
  }
}

export function assertDraftCallbackConfigured(config: Config): string {
  return requireDraftCallbackSecret(config);
}
