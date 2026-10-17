import { z } from "zod";
import type { EligibilityBody } from "./eligibilityBody.ts";

export const PLACEMENT_BASE_URL = "https://placements.4gd.ai/backendapi-latest/";
const DEFAULT_TIMEOUT_MS = 20_000;

export type PlacementOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "unauthorized" }
  | { kind: "rateLimited"; retryAfterMs?: number }
  | { kind: "unavailable"; status: 502 | 503 | 504 }
  | { kind: "timeout" }
  | { kind: "network"; message: string }
  | { kind: "http"; status: number }
  | { kind: "invalid"; reason: string }
  | { kind: "noToken"; profile: Record<string, unknown> };

export type PlacementLogger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
};

export type PlacementClientOptions = {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  timeoutMs?: number;
  log?: PlacementLogger;
  /** Called when an authenticated call returns 401 (stored token is invalid). */
  onUnauthorized?: () => void | Promise<void>;
};

const eventFieldsSchema = z
  .object({
    _id: z.string().min(1),
    updatedAt: z.unknown().optional(),
    isEligible: z.boolean().optional(),
    deadline: z.unknown().optional(),
    customFields: z.unknown().optional(),
    pdfUrls: z.unknown().optional(),
  })
  .passthrough();

const listResponseSchema = z
  .object({
    success: z.literal(true),
    events: z.array(eventFieldsSchema),
  })
  .passthrough();

const loginResponseSchema = z
  .object({
    success: z.unknown().optional(),
    token: z.string().optional(),
    studentData: z.record(z.string(), z.unknown()).optional(),
    student: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const checkApplyStatusSchema = z
  .object({
    applied: z.boolean().optional(),
    hasApplied: z.boolean().optional(),
    canApply: z.boolean().optional(),
    eligibilityReasons: z.unknown().optional(),
  })
  .passthrough();

export type CatalogEvent = z.infer<typeof eventFieldsSchema>;
export type CatalogList = z.infer<typeof listResponseSchema>;

export type LoginOk = {
  token: string;
  profile: Record<string, unknown>;
};

export type ApplyStatus = {
  applied: boolean;
  canApply?: boolean;
  eligibilityReasons?: unknown;
  raw: Record<string, unknown>;
};

export type AppliedEventItem = {
  eventId: string;
  selectionStatus: string | null;
  companyName: string | null;
  eventName: string | null;
  companyUsername: string | null;
  raw: Record<string, unknown>;
};

export type StudentProfile = Record<string, unknown>;

/** Exported for tests. */
export function parseAppliedEventsPayload(json: unknown): AppliedEventItem[] | null {
  let rows: unknown;
  if (Array.isArray(json)) {
    rows = json;
  } else if (json && typeof json === "object" && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.appliedEvents)) {
      rows = obj.appliedEvents;
    } else if (Array.isArray(obj.events)) {
      rows = obj.events;
    } else {
      return null;
    }
  } else {
    return null;
  }

  const out: AppliedEventItem[] = [];
  for (const row of rows as unknown[]) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const rec = row as Record<string, unknown>;
    const idRaw = rec.eventID ?? rec.eventId ?? rec._id ?? rec.id;
    if (typeof idRaw !== "string" || idRaw.trim() === "") {
      continue;
    }
    const company =
      (typeof rec.companyName === "string" && rec.companyName) ||
      (typeof rec.company === "string" && rec.company) ||
      null;
    const eventName =
      (typeof rec.eventName === "string" && rec.eventName) ||
      (typeof rec.name === "string" && rec.name) ||
      null;
    const companyUsername =
      typeof rec.companyUsername === "string" ? rec.companyUsername : null;
    const selectionStatus =
      typeof rec.selectionStatus === "string" ? rec.selectionStatus : null;
    out.push({
      eventId: idRaw.trim(),
      selectionStatus,
      companyName: company,
      eventName,
      companyUsername,
      raw: rec,
    });
  }
  return out;
}

export function appliedSelectionWantsAccepted(selectionStatus: string | null): boolean {
  if (!selectionStatus) {
    return false;
  }
  const s = selectionStatus.toLowerCase();
  return s === "placed" || s === "selected";
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const asInt = Number(header);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.round(asInt * 1000);
  }
  const when = Date.parse(header);
  if (Number.isFinite(when)) {
    return Math.max(0, when - Date.now());
  }
  return undefined;
}

function extractProfile(body: z.infer<typeof loginResponseSchema>): Record<string, unknown> {
  if (body.studentData && typeof body.studentData === "object") {
    return body.studentData;
  }
  if (body.student && typeof body.student === "object") {
    return body.student;
  }
  const { token: _token, ...rest } = body;
  return rest as Record<string, unknown>;
}

export class PlacementClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly log: PlacementLogger | undefined;
  private readonly onUnauthorized: (() => void | Promise<void>) | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: PlacementClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? PLACEMENT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log;
    this.onUnauthorized = options.onUnauthorized;
  }

  /** Enqueue so only one placement call is in flight. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async request(
    route: string,
    init: {
      method: string;
      path: string;
      body?: unknown;
      /** When set, sent as multipart; do not set Content-Type (boundary). */
      formData?: FormData;
      token?: string;
      /** When true, a 401 clears the stored token via onUnauthorized. */
      clearTokenOn401: boolean;
      timeoutMs?: number;
    },
  ): Promise<PlacementOutcome<{ status: number; json: unknown; durationMs: number }>> {
    const url = new URL(init.path, this.baseUrl).toString();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body !== undefined && !init.formData) {
      headers["Content-Type"] = "application/json";
    }
    if (init.token) {
      headers.Authorization = `Bearer ${init.token}`;
    }

    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers,
        body: init.formData
          ? init.formData
          : init.body === undefined
            ? undefined
            : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs),
      });
    } catch (error) {
      const durationMs = Date.now() - started;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        this.logOutcome(route, undefined, durationMs, "timeout");
        return { kind: "timeout" };
      }
      const message = error instanceof Error ? error.message : "network error";
      this.logOutcome(route, undefined, durationMs, "network");
      return { kind: "network", message };
    }

    const durationMs = Date.now() - started;
    const status = response.status;

    if (status === 401) {
      this.logOutcome(route, status, durationMs, "unauthorized");
      if (init.clearTokenOn401 && this.onUnauthorized) {
        await this.onUnauthorized();
      }
      return { kind: "unauthorized" };
    }
    if (status === 429) {
      this.logOutcome(route, status, durationMs, "rateLimited");
      return { kind: "rateLimited", retryAfterMs: parseRetryAfter(response.headers.get("retry-after")) };
    }
    if (status === 502 || status === 503 || status === 504) {
      this.logOutcome(route, status, durationMs, "unavailable");
      return { kind: "unavailable", status };
    }

    let json: unknown;
    const text = await response.text();
    if (text.length === 0) {
      json = null;
    } else {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        this.logOutcome(route, status, durationMs, "invalid");
        return { kind: "invalid", reason: "non-json body" };
      }
    }

    if (status < 200 || status >= 300) {
      this.logOutcome(route, status, durationMs, "http");
      return { kind: "http", status };
    }

    this.logOutcome(route, status, durationMs, "ok");
    return { kind: "ok", data: { status, json, durationMs } };
  }

  private logOutcome(route: string, status: number | undefined, durationMs: number, outcome: string): void {
    this.log?.info({ route, status, durationMs, outcome }, "placement call");
  }

  validateStudent(studentID: string, password: string): Promise<PlacementOutcome<LoginOk>> {
    return this.enqueue(async () => {
      const raw = await this.request("validatestudent", {
        method: "POST",
        path: "user/validatestudent",
        body: { studentID, password },
        clearTokenOn401: false,
      });
      if (raw.kind !== "ok") {
        return raw;
      }

      const parsed = loginResponseSchema.safeParse(raw.data.json);
      if (!parsed.success) {
        return { kind: "invalid", reason: "login schema mismatch" };
      }

      const profile = extractProfile(parsed.data);
      const token = parsed.data.token;
      if (typeof token === "string" && token.length > 0) {
        return { kind: "ok", data: { token, profile } };
      }
      return { kind: "noToken", profile };
    });
  }

  getEventsByStudentEligibility(
    token: string,
    body: EligibilityBody,
  ): Promise<PlacementOutcome<CatalogList>> {
    return this.enqueue(async () => {
      const raw = await this.request("getEventsByStudentEligibility", {
        method: "POST",
        path: "events/getEventsByStudentEligibility",
        body,
        token,
        clearTokenOn401: true,
      });
      if (raw.kind !== "ok") {
        return raw;
      }

      // Trust empty catalog only on HTTP 200 + success: true + events array.
      const parsed = listResponseSchema.safeParse(raw.data.json);
      if (!parsed.success) {
        return { kind: "invalid", reason: "list schema mismatch or success not true" };
      }
      return { kind: "ok", data: parsed.data };
    });
  }

  getEventDetails(token: string, id: string): Promise<PlacementOutcome<CatalogEvent>> {
    return this.enqueue(async () => {
      const raw = await this.request("getEventDetails", {
        method: "GET",
        path: `events/getEventDetails/${encodeURIComponent(id)}`,
        token,
        clearTokenOn401: true,
      });
      if (raw.kind !== "ok") {
        return raw;
      }

      const parsed = eventFieldsSchema.safeParse(raw.data.json);
      if (!parsed.success) {
        return { kind: "invalid", reason: "detail schema mismatch" };
      }
      return { kind: "ok", data: parsed.data };
    });
  }

  getStudent(token: string, studentID: string): Promise<PlacementOutcome<StudentProfile>> {
    return this.enqueue(async () => {
      const raw = await this.request("getStudent", {
        method: "GET",
        path: `students/${encodeURIComponent(studentID)}`,
        token,
        clearTokenOn401: true,
      });
      if (raw.kind !== "ok") {
        return raw;
      }

      const json = raw.data.json;
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        return { kind: "invalid", reason: "getStudent body not an object" };
      }
      const obj = json as Record<string, unknown>;
      if (typeof obj.studentID === "string") {
        return { kind: "ok", data: obj };
      }
      if (obj.success === true && obj.studentData && typeof obj.studentData === "object") {
        return { kind: "ok", data: obj.studentData as Record<string, unknown> };
      }
      return { kind: "invalid", reason: "getStudent unexpected shape" };
    });
  }

  uploadEventResume(
    token: string,
    input: {
      studentID: string;
      eventID: string;
      pdf: Uint8Array | Buffer;
      originalFilename: string;
    },
  ): Promise<PlacementOutcome<{ success: boolean; message?: string }>> {
    return this.enqueue(async () => {
      const form = new FormData();
      form.set("studentID", input.studentID);
      form.set("eventID", input.eventID);
      form.set("originalFilename", input.originalFilename);
      form.set(
        "resume",
        new File([Uint8Array.from(input.pdf)], input.originalFilename, {
          type: "application/pdf",
        }),
      );
      const raw = await this.request("uploadEventResume", {
        method: "POST",
        path: "studentevents/uploadEventResume",
        formData: form,
        token,
        clearTokenOn401: true,
        timeoutMs: 30_000,
      });
      if (raw.kind !== "ok") {
        return raw;
      }
      const json = raw.data.json;
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        return { kind: "invalid", reason: "uploadEventResume body not an object" };
      }
      const obj = json as Record<string, unknown>;
      if (obj.success === false) {
        return {
          kind: "invalid",
          reason: typeof obj.message === "string" ? obj.message : "uploadEventResume failed",
        };
      }
      return {
        kind: "ok",
        data: {
          success: obj.success !== false,
          message: typeof obj.message === "string" ? obj.message : undefined,
        },
      };
    });
  }

  applyToEvent(
    token: string,
    input: {
      studentID: string;
      fullName: string;
      eventID: string;
      eventName: string;
      companyUsername: string;
      customFieldResponses: Record<string, string>;
    },
  ): Promise<PlacementOutcome<{ status: number; message?: string }>> {
    return this.enqueue(async () => {
      const raw = await this.request("apply", {
        method: "POST",
        path: "studentevents/apply",
        body: {
          applicationStatus: "Applied",
          companyUsername: input.companyUsername,
          eventID: input.eventID,
          eventName: input.eventName,
          fullName: input.fullName,
          studentID: input.studentID,
          customFieldResponses: input.customFieldResponses,
        },
        token,
        clearTokenOn401: true,
      });
      if (raw.kind === "http" && (raw.status === 403 || raw.status === 409)) {
        return raw;
      }
      if (raw.kind !== "ok") {
        return raw;
      }
      return { kind: "ok", data: { status: raw.data.status } };
    });
  }

  /**
   * Historical applications. Body `{ studentID }`.
   * Response may be `{ appliedEvents: [...] }` or a bare array.
   */
  getAppliedEvents(
    token: string,
    studentID: string,
  ): Promise<PlacementOutcome<AppliedEventItem[]>> {
    return this.enqueue(async () => {
      const raw = await this.request("getAppliedEvents", {
        method: "POST",
        path: "studentevents/getAppliedEvents",
        body: { studentID },
        token,
        clearTokenOn401: true,
      });
      if (raw.kind !== "ok") {
        return raw;
      }
      const items = parseAppliedEventsPayload(raw.data.json);
      if (items === null) {
        return { kind: "invalid", reason: "getAppliedEvents schema mismatch" };
      }
      return { kind: "ok", data: items };
    });
  }

  checkApplyStatus(
    token: string,
    studentID: string,
    eventID: string,
  ): Promise<PlacementOutcome<ApplyStatus>> {
    return this.enqueue(async () => {
      const raw = await this.request("checkApplyStatus", {
        method: "POST",
        path: "studentevents/checkApplyStatus",
        body: { studentID, eventID },
        token,
        clearTokenOn401: true,
      });
      if (raw.kind !== "ok") {
        return raw;
      }

      const parsed = checkApplyStatusSchema.safeParse(raw.data.json);
      if (!parsed.success) {
        return { kind: "invalid", reason: "checkApplyStatus schema mismatch" };
      }
      const applied = parsed.data.applied ?? parsed.data.hasApplied;
      if (typeof applied !== "boolean") {
        return { kind: "invalid", reason: "checkApplyStatus missing applied/hasApplied" };
      }
      return {
        kind: "ok",
        data: {
          applied,
          canApply: parsed.data.canApply,
          eligibilityReasons: parsed.data.eligibilityReasons,
          raw: parsed.data as Record<string, unknown>,
        },
      };
    });
  }

  /** Login OTP only — never send purpose: passwordReset. */
  sendOtp(studentID: string): Promise<PlacementOutcome<{ email?: string }>> {
    return this.enqueue(async () => {
      const raw = await this.request("sendOtp", {
        method: "POST",
        path: "students/sendOtp",
        body: { studentID },
        clearTokenOn401: false,
      });
      if (raw.kind !== "ok") {
        return raw;
      }
      const json = raw.data.json;
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        return { kind: "invalid", reason: "sendOtp body not an object" };
      }
      const obj = json as Record<string, unknown>;
      if (obj.success === false) {
        return { kind: "invalid", reason: "sendOtp success false" };
      }
      return {
        kind: "ok",
        data: { email: typeof obj.email === "string" ? obj.email : undefined },
      };
    });
  }

  verifyOtp(studentID: string, otp: string): Promise<PlacementOutcome<LoginOk>> {
    return this.enqueue(async () => {
      const raw = await this.request("verifyOtp", {
        method: "POST",
        path: "students/verifyOtp",
        body: { studentID, otp },
        clearTokenOn401: false,
      });
      if (raw.kind !== "ok") {
        return raw;
      }

      const parsed = loginResponseSchema.safeParse(raw.data.json);
      if (!parsed.success) {
        return { kind: "invalid", reason: "verifyOtp schema mismatch" };
      }

      const profile = extractProfile(parsed.data);
      const token = parsed.data.token;
      if (typeof token === "string" && token.length > 0) {
        return { kind: "ok", data: { token, profile } };
      }
      return { kind: "noToken", profile };
    });
  }
}

/** Exported for fixture tests. */
export const placementSchemas = {
  eventFieldsSchema,
  listResponseSchema,
  loginResponseSchema,
  checkApplyStatusSchema,
};
