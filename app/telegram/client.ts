export type TelegramLogger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
};

export type TelegramClientOptions = {
  botToken: string;
  fetch?: typeof globalThis.fetch;
  log?: TelegramLogger;
};

export type SendMessageResult =
  | { ok: true; messageId: number }
  | { ok: false; reason: string };

export class TelegramClient {
  private readonly botToken: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly log: TelegramLogger | undefined;

  constructor(options: TelegramClientOptions) {
    this.botToken = options.botToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.log = options.log;
  }

  private async api(method: string, body: Record<string, unknown>): Promise<SendMessageResult & { raw?: unknown }> {
    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "network error";
      this.log?.warn({ method, outcome: "network", durationMs: Date.now() - started }, "telegram call");
      return { ok: false, reason };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      this.log?.warn({ method, status: response.status, outcome: "invalid" }, "telegram call");
      return { ok: false, reason: "non-json body" };
    }

    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    if (obj.ok === true) {
      const result = obj.result && typeof obj.result === "object" ? (obj.result as Record<string, unknown>) : {};
      const messageId = typeof result.message_id === "number" ? result.message_id : 0;
      this.log?.info(
        { method, status: response.status, outcome: "ok", durationMs: Date.now() - started },
        "telegram call",
      );
      return { ok: true, messageId };
    }

    const description = typeof obj.description === "string" ? obj.description : `http ${response.status}`;
    this.log?.warn(
      { method, status: response.status, outcome: "error", durationMs: Date.now() - started },
      "telegram call",
    );
    return { ok: false, reason: description };
  }

  sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<SendMessageResult> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }
    return this.api("sendMessage", body);
  }

  answerCallbackQuery(callbackQueryId: string, text: string): Promise<SendMessageResult> {
    return this.api("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  }
}
