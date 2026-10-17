/**
 * Fire a Claude Code routine via its API trigger.
 * @see https://platform.claude.com/docs/en/api/claude-code/routines-fire
 */

export type ClaudeFireLogger = {
  info?: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
};

export type PostClaudeRoutineFireResult =
  | { ok: true; status: number; sessionId?: string; sessionUrl?: string }
  | { ok: false; reason: string; status?: number };

/** Compact pointer sent in routine `text` (full payload fetched separately). */
export type ClaudeFirePointer = {
  driveId: string;
  company: string;
  role: string;
  payloadUrl: string;
  callbackUrl: string;
  callbackSecret: string;
};

const ANTHROPIC_VERSION = "2023-06-01";
const TEXT_MAX = 65_536;

/**
 * POST the prepare pointer to the Claude Code routine fire endpoint.
 */
export async function postClaudeRoutineFire(input: {
  fireUrl: string;
  fireToken: string;
  pointer: ClaudeFirePointer;
  fetch?: typeof globalThis.fetch;
  log?: ClaudeFireLogger;
}): Promise<PostClaudeRoutineFireResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch.bind(globalThis);
  const text = JSON.stringify(input.pointer);
  if (text.length > TEXT_MAX) {
    return { ok: false, reason: `fire text exceeds ${TEXT_MAX} characters` };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.fireToken}`,
    "anthropic-version": ANTHROPIC_VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const started = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(input.fireUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network error";
    input.log?.warn?.({ outcome: "network", reason, durationMs: Date.now() - started }, "claude routine fire");
    return { ok: false, reason };
  }

  if (response.status >= 200 && response.status < 300) {
    let sessionId: string | undefined;
    let sessionUrl: string | undefined;
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body.claude_code_session_id === "string") {
        sessionId = body.claude_code_session_id;
      }
      if (typeof body.claude_code_session_url === "string") {
        sessionUrl = body.claude_code_session_url;
      }
    } catch {
      // Body parse is best-effort; 2xx still counts as accepted.
    }
    input.log?.info?.(
      {
        outcome: "ok",
        status: response.status,
        sessionId,
        durationMs: Date.now() - started,
      },
      "claude routine fire",
    );
    return { ok: true, status: response.status, sessionId, sessionUrl };
  }

  const reason = `http ${response.status}`;
  input.log?.warn?.(
    { outcome: "error", status: response.status, durationMs: Date.now() - started },
    "claude routine fire",
  );
  return { ok: false, reason, status: response.status };
}
