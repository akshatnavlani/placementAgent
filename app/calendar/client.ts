export type CalendarLogger = {
  info?: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
};

export type CalendarClientOptions = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof globalThis.fetch;
  log?: CalendarLogger;
};

export type CalendarEventInput = {
  summary: string;
  description?: string;
  start: Date;
  end: Date;
  timeZone?: string;
};

type TokenOutcome = { ok: true; accessToken: string } | { ok: false; reason: string };

export type CalendarOutcome<T> = { ok: true; value: T } | { ok: false; reason: string; notFound?: boolean };

const IST = "Asia/Kolkata";
const PLACEMENTS_SUMMARY = "placements";

export class CalendarClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly log: CalendarLogger | undefined;
  private cachedAccess: { token: string; expiresAtMs: number } | null = null;

  constructor(options: CalendarClientOptions) {
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
      this.log?.warn?.({ outcome: "network" }, "calendar token refresh");
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
      this.log?.warn?.({ status: response.status, outcome: "error" }, "calendar token refresh");
      return { ok: false, reason: "token refresh failed" };
    }
    const expiresIn = typeof obj.expires_in === "number" ? obj.expires_in : 3600;
    this.cachedAccess = {
      token: obj.access_token,
      expiresAtMs: Date.now() + expiresIn * 1000,
    };
    return { ok: true, accessToken: obj.access_token };
  }

  async listCalendarSummaries(): Promise<CalendarOutcome<Array<{ id: string; summary: string }>>> {
    const token = await this.accessToken();
    if (!token.ok) {
      return token;
    }
    const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
    url.searchParams.set("maxResults", "250");
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
      return { ok: false, reason: "non-json calendarList" };
    }
    if (!response.ok) {
      this.log?.warn?.({ status: response.status }, "calendarList.list");
      return { ok: false, reason: `calendarList http ${response.status}` };
    }
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const items = Array.isArray(obj.items) ? obj.items : [];
    const out: Array<{ id: string; summary: string }> = [];
    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const row = item as { id?: string; summary?: string };
      if (typeof row.id === "string" && row.id && typeof row.summary === "string") {
        out.push({ id: row.id, summary: row.summary });
      }
    }
    return { ok: true, value: out };
  }

  async createCalendar(summary: string = PLACEMENTS_SUMMARY): Promise<CalendarOutcome<{ id: string }>> {
    const token = await this.accessToken();
    if (!token.ok) {
      return token;
    }
    let response: Response;
    try {
      response = await this.fetchImpl("https://www.googleapis.com/calendar/v3/calendars", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ summary, timeZone: IST }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "network error" };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: "non-json calendars.insert" };
    }
    if (!response.ok) {
      this.log?.warn?.({ status: response.status }, "calendars.insert");
      return { ok: false, reason: `calendars.insert http ${response.status}` };
    }
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    if (typeof obj.id !== "string" || !obj.id) {
      return { ok: false, reason: "calendars.insert missing id" };
    }
    if (obj.id === "primary") {
      return { ok: false, reason: "refusing primary calendar id" };
    }
    return { ok: true, value: { id: obj.id } };
  }

  async getCalendar(calendarId: string): Promise<CalendarOutcome<{ id: string; summary: string }>> {
    const token = await this.accessToken();
    if (!token.ok) {
      return token;
    }
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "network error" };
    }
    if (response.status === 404) {
      return { ok: false, reason: "calendar not found", notFound: true };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: "non-json calendars.get" };
    }
    if (!response.ok) {
      return { ok: false, reason: `calendars.get http ${response.status}` };
    }
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    if (typeof obj.id !== "string" || !obj.id) {
      return { ok: false, reason: "calendars.get missing id" };
    }
    return {
      ok: true,
      value: {
        id: obj.id,
        summary: typeof obj.summary === "string" ? obj.summary : "",
      },
    };
  }

  private eventBody(input: CalendarEventInput): Record<string, unknown> {
    const timeZone = input.timeZone ?? IST;
    return {
      summary: input.summary,
      description: input.description ?? "",
      start: { dateTime: input.start.toISOString(), timeZone },
      end: { dateTime: input.end.toISOString(), timeZone },
    };
  }

  async createEvent(
    calendarId: string,
    input: CalendarEventInput,
  ): Promise<CalendarOutcome<{ id: string }>> {
    if (calendarId === "primary") {
      return { ok: false, reason: "refusing primary calendar" };
    }
    const token = await this.accessToken();
    if (!token.ok) {
      return token;
    }
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(this.eventBody(input)),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "network error" };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: "non-json events.insert" };
    }
    if (response.status === 404) {
      return { ok: false, reason: "calendar not found", notFound: true };
    }
    if (!response.ok) {
      this.log?.warn?.({ status: response.status }, "events.insert");
      return { ok: false, reason: `events.insert http ${response.status}` };
    }
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    if (typeof obj.id !== "string" || !obj.id) {
      return { ok: false, reason: "events.insert missing id" };
    }
    return { ok: true, value: { id: obj.id } };
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    input: CalendarEventInput,
  ): Promise<CalendarOutcome<{ id: string }>> {
    if (calendarId === "primary") {
      return { ok: false, reason: "refusing primary calendar" };
    }
    const token = await this.accessToken();
    if (!token.ok) {
      return token;
    }
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(this.eventBody(input)),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "network error" };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: "non-json events.patch" };
    }
    if (response.status === 404) {
      return { ok: false, reason: "event not found", notFound: true };
    }
    if (!response.ok) {
      this.log?.warn?.({ status: response.status }, "events.patch");
      return { ok: false, reason: `events.patch http ${response.status}` };
    }
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    return { ok: true, value: { id: typeof obj.id === "string" ? obj.id : eventId } };
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<CalendarOutcome<{ deleted: true }>> {
    if (calendarId === "primary") {
      return { ok: false, reason: "refusing primary calendar" };
    }
    const token = await this.accessToken();
    if (!token.ok) {
      return token;
    }
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token.accessToken}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "network error" };
    }
    if (response.status === 404 || response.status === 410) {
      return { ok: true, value: { deleted: true } };
    }
    if (!response.ok) {
      this.log?.warn?.({ status: response.status }, "events.delete");
      return { ok: false, reason: `events.delete http ${response.status}` };
    }
    return { ok: true, value: { deleted: true } };
  }
}

export const PLACEMENTS_CALENDAR_SUMMARY = PLACEMENTS_SUMMARY;
