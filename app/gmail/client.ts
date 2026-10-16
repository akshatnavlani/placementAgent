export type GmailLogger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
};

export type GmailClientOptions = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof globalThis.fetch;
  log?: GmailLogger;
};

export type GmailMessageMeta = {
  id: string;
  internalDateMs: number;
  subject: string;
  snippet: string;
};

export type GmailMessageFull = GmailMessageMeta & {
  threadId: string;
  bodyText: string;
};

type TokenOutcome = { ok: true; accessToken: string } | { ok: false; reason: string };

export class GmailClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly log: GmailLogger | undefined;
  private cachedAccess: { token: string; expiresAtMs: number } | null = null;

  constructor(options: GmailClientOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.refreshToken = options.refreshToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.log = options.log;
  }

  private async accessToken(): Promise<TokenOutcome> {
    if (this.cachedAccess && this.cachedAccess.expiresAtMs > Date.now() + 60_000) {
      return { ok: true, accessToken: this.cachedAccess.token };
    }
    let response: Response;
    try {
      response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.refreshToken,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "network error";
      this.log?.warn({ outcome: "network" }, "gmail token refresh");
      return { ok: false, reason };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: "non-json token response" };
    }
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    if (!response.ok || typeof obj.access_token !== "string") {
      this.log?.warn({ status: response.status, outcome: "error" }, "gmail token refresh");
      return { ok: false, reason: "token refresh failed" };
    }
    const expiresIn = typeof obj.expires_in === "number" ? obj.expires_in : 3600;
    this.cachedAccess = {
      token: obj.access_token,
      expiresAtMs: Date.now() + expiresIn * 1000,
    };
    return { ok: true, accessToken: obj.access_token };
  }

  async listMessageIds(query: string, maxResults = 10): Promise<{ ok: true; ids: string[] } | { ok: false; reason: string }> {
    const token = await this.accessToken();
    if (!token.ok) {
      return token;
    }
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(maxResults));
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "network error" };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: "non-json list" };
    }
    if (!response.ok) {
      this.log?.warn({ status: response.status, outcome: "error" }, "gmail list");
      return { ok: false, reason: `list http ${response.status}` };
    }
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const messages = Array.isArray(obj.messages) ? obj.messages : [];
    const ids = messages
      .map((m) => (m && typeof m === "object" ? (m as { id?: string }).id : undefined))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return { ok: true, ids };
  }

  async getMessageMeta(id: string): Promise<{ ok: true; meta: GmailMessageMeta } | { ok: false; reason: string }> {
    const token = await this.accessToken();
    if (!token.ok) {
      return token;
    }
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "network error" };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: "non-json get" };
    }
    if (!response.ok) {
      return { ok: false, reason: `get http ${response.status}` };
    }
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const payload = obj.payload && typeof obj.payload === "object" ? (obj.payload as Record<string, unknown>) : {};
    const headers = Array.isArray(payload.headers) ? payload.headers : [];
    let subject = "";
    for (const header of headers) {
      if (!header || typeof header !== "object") {
        continue;
      }
      const h = header as { name?: string; value?: string };
      if (h.name?.toLowerCase() === "subject" && typeof h.value === "string") {
        subject = h.value;
      }
    }
    const internalDateMs = Number(obj.internalDate ?? 0);
    return {
      ok: true,
      meta: {
        id,
        internalDateMs: Number.isFinite(internalDateMs) ? internalDateMs : 0,
        subject,
        snippet: typeof obj.snippet === "string" ? obj.snippet : "",
      },
    };
  }

  async getProfile(): Promise<{ ok: true; historyId: string } | { ok: false; reason: string }> {
    const token = await this.accessToken();
    if (!token.ok) {
      return token;
    }
    let response: Response;
    try {
      response = await this.fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "network error" };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: "non-json profile" };
    }
    if (!response.ok) {
      return { ok: false, reason: `profile http ${response.status}` };
    }
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const historyId = obj.historyId != null ? String(obj.historyId) : "";
    if (!historyId) {
      return { ok: false, reason: "missing historyId" };
    }
    return { ok: true, historyId };
  }

  async listHistory(
    startHistoryId: string,
  ): Promise<
    | { ok: true; messageIds: string[]; historyId: string }
    | { ok: false; reason: string; stale?: boolean }
  > {
    const token = await this.accessToken();
    if (!token.ok) {
      return token;
    }
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
    url.searchParams.set("startHistoryId", startHistoryId);
    url.searchParams.set("historyTypes", "messageAdded");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "network error" };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: "non-json history" };
    }
    if (response.status === 404) {
      return { ok: false, reason: "stale historyId", stale: true };
    }
    if (!response.ok) {
      return { ok: false, reason: `history http ${response.status}` };
    }
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const historyId = obj.historyId != null ? String(obj.historyId) : startHistoryId;
    const history = Array.isArray(obj.history) ? obj.history : [];
    const ids = new Set<string>();
    for (const entry of history) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const messagesAdded = (entry as { messagesAdded?: unknown }).messagesAdded;
      if (!Array.isArray(messagesAdded)) {
        continue;
      }
      for (const added of messagesAdded) {
        if (!added || typeof added !== "object") {
          continue;
        }
        const message = (added as { message?: { id?: string } }).message;
        if (message && typeof message.id === "string" && message.id) {
          ids.add(message.id);
        }
      }
    }
    return { ok: true, messageIds: [...ids], historyId };
  }

  async getMessageFull(
    id: string,
  ): Promise<{ ok: true; message: GmailMessageFull } | { ok: false; reason: string }> {
    const token = await this.accessToken();
    if (!token.ok) {
      return token;
    }
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "network error" };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: "non-json get" };
    }
    if (!response.ok) {
      return { ok: false, reason: `get http ${response.status}` };
    }
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const payload = obj.payload && typeof obj.payload === "object" ? (obj.payload as GmailPayload) : null;
    const headers = payload && Array.isArray(payload.headers) ? payload.headers : [];
    let subject = "";
    for (const header of headers) {
      if (!header || typeof header !== "object") {
        continue;
      }
      const h = header as { name?: string; value?: string };
      if (h.name?.toLowerCase() === "subject" && typeof h.value === "string") {
        subject = h.value;
      }
    }
    const internalDateMs = Number(obj.internalDate ?? 0);
    const bodyText = extractPlainText(payload);
    return {
      ok: true,
      message: {
        id,
        threadId: typeof obj.threadId === "string" ? obj.threadId : "",
        internalDateMs: Number.isFinite(internalDateMs) ? internalDateMs : 0,
        subject,
        snippet: typeof obj.snippet === "string" ? obj.snippet : "",
        bodyText,
      },
    };
  }
}

type GmailPayload = {
  mimeType?: string;
  body?: { data?: string };
  headers?: unknown[];
  parts?: GmailPayload[];
};

function decodeBodyData(data: string | undefined): string {
  if (!data) {
    return "";
  }
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPlainText(payload: GmailPayload | null): string {
  if (!payload) {
    return "";
  }
  const mime = (payload.mimeType ?? "").toLowerCase();
  if (mime === "text/plain") {
    return decodeBodyData(payload.body?.data);
  }
  if (mime === "text/html") {
    return stripHtml(decodeBodyData(payload.body?.data));
  }
  if (Array.isArray(payload.parts)) {
    let htmlFallback = "";
    for (const part of payload.parts) {
      const partMime = (part.mimeType ?? "").toLowerCase();
      if (partMime === "text/plain") {
        const text = decodeBodyData(part.body?.data);
        if (text.trim()) {
          return text;
        }
      }
      if (partMime === "text/html" && !htmlFallback) {
        htmlFallback = stripHtml(decodeBodyData(part.body?.data));
      }
      if (partMime.startsWith("multipart/") && part.parts) {
        const nested = extractPlainText(part);
        if (nested.trim()) {
          return nested;
        }
      }
    }
    if (htmlFallback) {
      return htmlFallback;
    }
  }
  return decodeBodyData(payload.body?.data);
}
