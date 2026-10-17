import { describe, expect, it, vi } from "vitest";
import { postClaudeRoutineFire } from "../app/draft/claudeFire.ts";

const pointer = {
  driveId: "drive-1",
  company: "Acme",
  role: "SDE",
  payloadUrl: "https://watcher.example/draft/prepare-payload?driveId=drive-1",
  callbackUrl: "https://watcher.example/draft/callback",
  callbackSecret: "draft-callback-secret-0123456789abcdef0123",
};

describe("postClaudeRoutineFire", () => {
  it("POSTs text pointer with Anthropic headers", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          type: "routine_fire",
          claude_code_session_id: "session_01ABC",
          claude_code_session_url: "https://claude.ai/code/session_01ABC",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await postClaudeRoutineFire({
      fireUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_01/fire",
      fireToken: "sk-ant-oat01-test",
      pointer,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: true, status: 200, sessionId: "session_01ABC" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/claude_code/routines/trig_01/fire");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-ant-oat01-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(init?.body)) as { text: string };
    expect(JSON.parse(body.text)).toEqual(pointer);
  });

  it("returns http status on non-2xx", async () => {
    const result = await postClaudeRoutineFire({
      fireUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_01/fire",
      fireToken: "sk-ant-oat01-test",
      pointer,
      fetch: vi.fn(async () => new Response("no", { status: 401 })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "http 401", status: 401 });
  });

  it("returns network errors", async () => {
    const result = await postClaudeRoutineFire({
      fireUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_01/fire",
      fireToken: "sk-ant-oat01-test",
      pointer,
      fetch: vi.fn(async () => {
        throw new Error("connect reset");
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "connect reset" });
  });
});
