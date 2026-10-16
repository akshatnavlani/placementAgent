import type { PreparePayload } from "./payload.ts";

export type WebhookLogger = {
  info?: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
};

export type PostCursorWebhookResult =
  | { ok: true; status: number }
  | { ok: false; reason: string; status?: number };

/**
 * POST the prepare payload to the Cursor Automation webhook.
 * Optional bearer secret if the automation requires it.
 */
export async function postCursorWebhook(input: {
  url: string;
  secret?: string;
  payload: PreparePayload;
  fetch?: typeof globalThis.fetch;
  log?: WebhookLogger;
}): Promise<PostCursorWebhookResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (input.secret) {
    headers.Authorization = `Bearer ${input.secret}`;
  }

  const started = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      method: "POST",
      headers,
      body: JSON.stringify(input.payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network error";
    input.log?.warn?.({ outcome: "network", reason, durationMs: Date.now() - started }, "cursor webhook");
    return { ok: false, reason };
  }

  if (response.status >= 200 && response.status < 300) {
    input.log?.info?.(
      { outcome: "ok", status: response.status, durationMs: Date.now() - started },
      "cursor webhook",
    );
    return { ok: true, status: response.status };
  }

  const reason = `http ${response.status}`;
  input.log?.warn?.(
    { outcome: "error", status: response.status, durationMs: Date.now() - started },
    "cursor webhook",
  );
  return { ok: false, reason, status: response.status };
}
