import { describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../app/telegram/client.ts";

describe("TelegramClient.sendDocument", () => {
  it("posts multipart FormData with the filename", async () => {
    let sawForm = false;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init!.body as FormData;
      expect(form.get("chat_id")).toBe("1");
      const doc = form.get("document");
      expect(doc).toBeInstanceOf(File);
      expect((doc as File).name).toBe("resume.tex");
      sawForm = true;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
    });

    const client = new TelegramClient({
      botToken: "bot",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.sendDocument("1", {
      filename: "resume.tex",
      bytes: Buffer.from("hello"),
      contentType: "application/x-tex",
    });
    expect(result).toEqual({ ok: true, messageId: 9 });
    expect(sawForm).toBe(true);
  });

  it("surfaces API errors", async () => {
    const client = new TelegramClient({
      botToken: "bot",
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, description: "file too big" }), { status: 200 }),
      ) as unknown as typeof fetch,
    });
    const result = await client.sendDocument("1", {
      filename: "a.pdf",
      bytes: Buffer.from("%PDF"),
    });
    expect(result).toEqual({ ok: false, reason: "file too big" });
  });
});
