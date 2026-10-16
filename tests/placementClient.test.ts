import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { loggerOptions } from "../app/log.ts";
import { PlacementClient } from "../app/placement/client.ts";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const app = Fastify({ logger: { ...loggerOptions("info"), stream } });
  return { log: app.log, lines, close: () => app.close() };
}

describe("PlacementClient outcomes", () => {
  it("maps 200 + success true to ok", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { success: true, events: [{ _id: "e1", isEligible: true }] }),
    );
    const client = new PlacementClient({ fetch: fetchMock as unknown as typeof fetch });
    const result = await client.getEventsByStudentEligibility("tok", { batch: 2027 });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.data.events).toHaveLength(1);
    }
  });

  it("treats 200 + success false as invalid, not empty catalog", async () => {
    const client = new PlacementClient({
      fetch: vi.fn(async () => jsonResponse(200, { success: false, events: [] })) as unknown as typeof fetch,
    });
    const result = await client.getEventsByStudentEligibility("tok", {});
    expect(result).toEqual({ kind: "invalid", reason: "list schema mismatch or success not true" });
  });

  it("maps non-json bodies to invalid", async () => {
    const client = new PlacementClient({
      fetch: vi.fn(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch,
    });
    const result = await client.getEventsByStudentEligibility("tok", {});
    expect(result.kind).toBe("invalid");
  });

  it("maps 401 to unauthorized", async () => {
    const client = new PlacementClient({
      fetch: vi.fn(async () => jsonResponse(401, { message: "no" })) as unknown as typeof fetch,
    });
    expect(await client.getEventsByStudentEligibility("tok", {})).toEqual({ kind: "unauthorized" });
  });

  it("maps 404 to http", async () => {
    const client = new PlacementClient({
      fetch: vi.fn(async () => jsonResponse(404, { message: "missing" })) as unknown as typeof fetch,
    });
    expect(await client.validateStudent("x", "y")).toEqual({ kind: "http", status: 404 });
  });

  it("maps 429 with Retry-After", async () => {
    const client = new PlacementClient({
      fetch: vi.fn(async () =>
        jsonResponse(429, { message: "slow" }, { "retry-after": "2" }),
      ) as unknown as typeof fetch,
    });
    expect(await client.getEventsByStudentEligibility("tok", {})).toEqual({
      kind: "rateLimited",
      retryAfterMs: 2000,
    });
  });

  it("maps 502 to unavailable", async () => {
    const client = new PlacementClient({
      fetch: vi.fn(async () => jsonResponse(502, { message: "bad gateway" })) as unknown as typeof fetch,
    });
    expect(await client.getEventsByStudentEligibility("tok", {})).toEqual({
      kind: "unavailable",
      status: 502,
    });
  });

  it("maps timeout", async () => {
    const client = new PlacementClient({
      timeoutMs: 5,
      fetch: vi.fn(async (_url, init) => {
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "TimeoutError";
            reject(err);
          });
        });
      }) as unknown as typeof fetch,
    });
    expect(await client.getEventsByStudentEligibility("tok", {})).toEqual({ kind: "timeout" });
  });

  it("maps network errors", async () => {
    const client = new PlacementClient({
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const result = await client.getEventsByStudentEligibility("tok", {});
    expect(result.kind).toBe("network");
  });
});

describe("PlacementClient token clearing", () => {
  it("clears stored token on 401 for authenticated calls", async () => {
    const onUnauthorized = vi.fn(async () => undefined);
    const client = new PlacementClient({
      onUnauthorized,
      fetch: vi.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch,
    });
    await client.getEventsByStudentEligibility("stored-token", {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not clear on 429, 502, or timeout", async () => {
    const onUnauthorized = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { "retry-after": "1" }))
      .mockResolvedValueOnce(jsonResponse(502, {}))
      .mockImplementationOnce(async () => {
        const err = new Error("aborted");
        err.name = "TimeoutError";
        throw err;
      });
    const client = new PlacementClient({
      onUnauthorized,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.getEventsByStudentEligibility("tok", {});
    await client.getEventsByStudentEligibility("tok", {});
    await client.getEventsByStudentEligibility("tok", {});
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("does not clear on login 401 (wrong password)", async () => {
    const onUnauthorized = vi.fn(async () => undefined);
    const client = new PlacementClient({
      onUnauthorized,
      fetch: vi.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch,
    });
    await client.validateStudent("id", "bad-password");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("PlacementClient serial queue", () => {
  it("never overlaps two placement calls", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return jsonResponse(200, { success: true, events: [] });
    });
    const client = new PlacementClient({ fetch: fetchMock as unknown as typeof fetch });
    await Promise.all([
      client.getEventsByStudentEligibility("a", {}),
      client.getEventDetails("a", "e1"),
      client.getStudent("a", "id"),
    ]);
    expect(maxInFlight).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("PlacementClient logging", () => {
  it("never logs the password", async () => {
    const { log, lines, close } = captureLogger();
    const password = "super-secret-password-xyz";
    const client = new PlacementClient({
      log: {
        info: (obj, msg) => log.info(obj, msg),
        warn: (obj, msg) => log.warn(obj, msg),
      },
      fetch: vi.fn(async () =>
        jsonResponse(200, { success: true, token: "tok", studentData: { studentID: "x" } }),
      ) as unknown as typeof fetch,
    });
    await client.validateStudent("PES1UG00XX000", password);
    const output = lines.join("");
    expect(output).not.toContain(password);
    expect(output).toContain("validatestudent");
    await close();
  });
});

describe("PlacementClient login branches", () => {
  it("returns noToken when success without token", async () => {
    const client = new PlacementClient({
      fetch: vi.fn(async () =>
        jsonResponse(200, { success: true, studentData: { studentID: "x" } }),
      ) as unknown as typeof fetch,
    });
    const result = await client.validateStudent("x", "y");
    expect(result.kind).toBe("noToken");
  });

  it("prefers studentData over student for the profile", async () => {
    const client = new PlacementClient({
      fetch: vi.fn(async () =>
        jsonResponse(200, {
          success: true,
          token: "t",
          studentData: { studentID: "fromData" },
          student: { studentID: "fromStudent" },
        }),
      ) as unknown as typeof fetch,
    });
    const result = await client.validateStudent("x", "y");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.data.profile.studentID).toBe("fromData");
    }
  });
});

describe("getStudent and checkApplyStatus shapes", () => {
  it("accepts a bare profile from getStudent", async () => {
    const client = new PlacementClient({
      fetch: vi.fn(async () => jsonResponse(200, { studentID: "PES1UG00XX000", batch: 2027 })) as unknown as typeof fetch,
    });
    const result = await client.getStudent("tok", "PES1UG00XX000");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.data.studentID).toBe("PES1UG00XX000");
    }
  });

  it("reads applied from hasApplied when applied is missing", async () => {
    const client = new PlacementClient({
      fetch: vi.fn(async () =>
        jsonResponse(200, { hasApplied: true, canApply: false, eligibilityReasons: [] }),
      ) as unknown as typeof fetch,
    });
    const result = await client.checkApplyStatus("tok", "id", "event");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.data.applied).toBe(true);
    }
  });
});
