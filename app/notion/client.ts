export type NotionLogger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
};

export type NotionClientOptions = {
  token: string;
  fetch?: typeof globalThis.fetch;
  log?: NotionLogger;
};

export type NotionOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; status?: number; code?: string; authError?: boolean };

const NOTION_VERSION = "2022-06-28";
const BASE = "https://api.notion.com/v1";

export class NotionClient {
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly log: NotionLogger | undefined;

  constructor(options: NotionClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.log = options.log;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<NotionOutcome<T>> {
    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "network error";
      this.log?.warn({ method, path, outcome: "network", durationMs: Date.now() - started }, "notion call");
      return { ok: false, reason };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      this.log?.warn(
        { method, path, status: response.status, outcome: "invalid", durationMs: Date.now() - started },
        "notion call",
      );
      return { ok: false, reason: "non-json body", status: response.status };
    }

    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    if (!response.ok) {
      const code = typeof obj.code === "string" ? obj.code : undefined;
      const message = typeof obj.message === "string" ? obj.message : `http ${response.status}`;
      const authError = response.status === 401 || response.status === 403;
      this.log?.warn(
        {
          method,
          path,
          status: response.status,
          code,
          outcome: authError ? "auth" : "error",
          durationMs: Date.now() - started,
        },
        "notion call",
      );
      return { ok: false, reason: message, status: response.status, code, authError };
    }

    this.log?.info(
      { method, path, status: response.status, outcome: "ok", durationMs: Date.now() - started },
      "notion call",
    );
    return { ok: true, data: json as T };
  }

  createPage(
    databaseId: string,
    properties: Record<string, unknown>,
  ): Promise<NotionOutcome<{ id: string }>> {
    return this.request("POST", "/pages", {
      parent: { database_id: databaseId },
      properties,
    });
  }

  updatePage(
    pageId: string,
    properties: Record<string, unknown>,
  ): Promise<NotionOutcome<{ id: string }>> {
    return this.request("PATCH", `/pages/${pageId}`, { properties });
  }

  retrievePage(pageId: string): Promise<NotionOutcome<{ id: string; properties: Record<string, unknown> }>> {
    return this.request("GET", `/pages/${pageId}`);
  }
}
