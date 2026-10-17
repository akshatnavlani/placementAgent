import type { Config } from "../config.ts";
import { hasTelegram, requireTelegram } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { getLatestDraft, markDraftDelivered } from "../db/draft.ts";
import { getDrive } from "../db/drive.ts";
import { draftReadyKeyboard } from "../telegram/buttons.ts";
import { TelegramClient } from "../telegram/client.ts";
import { compileLatexToPdf, type CompileDeps } from "./compile.ts";
import { formatAnswersList, parseAtsComments, sanitizeFilename } from "./formatAnswers.ts";
import { extractCustomFields } from "./payload.ts";

export type DeliverResult =
  | { kind: "delivered"; driveId: string; pdf: boolean }
  | { kind: "already_delivered"; driveId: string }
  | { kind: "missing_draft" }
  | { kind: "not_ready" }
  | { kind: "no_telegram" }
  | { kind: "partial"; reason: string };

export type DeliverDeps = {
  config: Config;
  db: DbClient;
  fetch?: typeof globalThis.fetch;
  telegram?: TelegramClient;
  compile?: CompileDeps;
  log?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
  now?: Date;
};

export async function deliverReadyDraft(
  deps: DeliverDeps,
  driveId: string,
): Promise<DeliverResult> {
  if (!hasTelegram(deps.config)) {
    return { kind: "no_telegram" };
  }

  const drive = await getDrive(deps.db, driveId);
  const draft = await getLatestDraft(deps.db, driveId);
  if (!draft || !drive) {
    return { kind: "missing_draft" };
  }
  if (draft.status !== "ready" || !draft.latex?.trim()) {
    return { kind: "not_ready" };
  }
  if (draft.delivered_at) {
    return { kind: "already_delivered", driveId };
  }

  const tgCfg = requireTelegram(deps.config);
  const telegram =
    deps.telegram ??
    new TelegramClient({
      botToken: tgCfg.botToken,
      fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    });
  const chatId = tgCfg.chatId;
  const company = drive.company_name?.trim() || driveId;
  const fields = extractCustomFields(drive.raw_detail ?? drive.raw_list);
  const ats = parseAtsComments(draft.latex);
  const keyboard = draftReadyKeyboard(driveId);

  const statusLines = [`Draft ready for ${company}.`];
  if (ats.match) {
    statusLines.push(`ATS match: ${ats.match}${ats.note ? ` — ${ats.note}` : ""}`);
  }

  const sendText = async (text: string, replyMarkup?: Record<string, unknown>) => {
    const r = await telegram.sendMessage(chatId, text.slice(0, 4000), replyMarkup);
    if (!r.ok) {
      throw new Error(r.reason);
    }
  };

  try {
    await sendText(statusLines.join("\n"), keyboard);
    await sendText(formatAnswersList(draft.answers, fields));

    const base = sanitizeFilename(company);
    let pdfOk = false;
    const compiled = await compileLatexToPdf(draft.latex, driveId, {
      ...deps.compile,
      fetch: deps.fetch ?? deps.compile?.fetch,
    });
    if (compiled.ok) {
      const pdfSend = await telegram.sendDocument(chatId, {
        filename: `${base}-resume.pdf`,
        bytes: compiled.pdf,
        contentType: "application/pdf",
      });
      if (pdfSend.ok) {
        pdfOk = true;
      } else {
        await sendText(`PDF skipped: ${pdfSend.reason}.`);
      }
    } else {
      await sendText(`PDF skipped: ${compiled.reason}.`);
    }

    await markDraftDelivered(deps.db, driveId, deps.now ?? new Date());
    deps.log?.info?.({ driveId, pdf: pdfOk, answerCount: draft.answers.length }, "draft delivered");
    return { kind: "delivered", driveId, pdf: pdfOk };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "delivery failed";
    deps.log?.warn?.({ driveId, reason }, "draft delivery failed");
    try {
      await telegram.sendMessage(
        chatId,
        `Draft ready for ${company}, but delivery failed: ${reason}. Tap Prepare again to retry send.`,
      );
    } catch {
      // ignore
    }
    return { kind: "partial", reason };
  }
}
