import { describe, expect, it, vi } from "vitest";
import {
  handlePrepareAskChoice,
  handlePrepareAskText,
  startPrepareAsk,
} from "../app/draft/askMissing.ts";
import { assertDropdownValue, formatAnswersList } from "../app/draft/formatAnswers.ts";
import { TelegramClient } from "../app/telegram/client.ts";

function askStore() {
  let onboarding: Record<string, unknown> = {};
  const answers: Array<Record<string, unknown>> = [];
  const profile = {
    student_id: "PES1",
    platform: {},
    platform_synced_at: null,
    manual: {},
    canonical_latex: "\\documentclass{article}",
    canonical_latex_updated_at: "2026-01-01T00:00:00.000Z",
    onboarding,
  };

  const db = {
    from(table: string) {
      if (table === "profile") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { ...profile, onboarding },
                error: null,
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: async () => {
              if (payload.onboarding !== undefined) {
                onboarding = payload.onboarding as Record<string, unknown>;
                profile.onboarding = onboarding;
              }
              return { error: null };
            },
          }),
        };
      }
      if (table === "answer") {
        return {
          select: () => ({
            then: undefined,
          }),
          // listAnswers uses select("*") without eq — supabase chain
          // simplified: intercept via custom
        };
      }
      throw new Error(table);
    },
  };

  // Patch listAnswers path: answer.select returns data
  db.from = ((table: string) => {
    if (table === "profile") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { ...profile, onboarding }, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async () => {
            if (payload.onboarding !== undefined) {
              onboarding = payload.onboarding as Record<string, unknown>;
              profile.onboarding = onboarding;
            }
            return { error: null };
          },
        }),
      };
    }
    if (table === "answer") {
      return {
        select: () => ({
          // listAnswers awaits db.from("answer").select("*") — need thenable
          then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
            resolve({ data: answers, error: null }),
        }),
        insert: async (row: Record<string, unknown>) => {
          answers.push({ id: `a${answers.length}`, ...row });
          return { error: null };
        },
        update: (payload: Record<string, unknown>) => ({
          eq: async () => {
            Object.assign(answers[0] ?? {}, payload);
            return { error: null };
          },
        }),
      };
    }
    throw new Error(table);
  }) as typeof db.from;

  return { db: db as never, getOnboarding: () => onboarding, answers };
}

function tg() {
  const messages: string[] = [];
  return {
    client: new TelegramClient({
      botToken: "bot",
      fetch: vi.fn(async (_u: string, init?: RequestInit) => {
        if (init?.body && typeof init.body === "string") {
          const parsed = JSON.parse(init.body) as { text?: string };
          if (parsed.text) {
            messages.push(parsed.text);
          }
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch,
    }),
    messages,
  };
}

describe("formatAnswers / dropdown", () => {
  it("rejects values not in options", () => {
    expect(
      assertDropdownValue({ label: "City", type: "dropdown", options: ["BLR", "HYD"] }, "DEL"),
    ).toMatchObject({ ok: false });
    expect(
      assertDropdownValue({ label: "City", type: "dropdown", options: ["BLR"] }, "BLR"),
    ).toEqual({ ok: true });
  });

  it("marks invalid agent answers in the list", () => {
    const text = formatAnswersList([{ label: "City", value: "DEL" }], [
      { id: null, label: "City", type: "dropdown", required: true, options: ["BLR", "HYD"] },
    ]);
    expect(text).toContain("(not in options)");
  });
});

describe("prepare_ask flow", () => {
  it("starts ask state and completes on text answer", async () => {
    const { db, getOnboarding, answers } = askStore();
    const { client } = tg();
    const deps = { db, telegram: client, chatId: "1" };

    await startPrepareAsk(deps, "drive-1", [
      { id: null, label: "Why us?", type: "text", required: true, options: [] },
    ]);
    expect(getOnboarding().mode).toBe("prepare_ask");
    expect(getOnboarding().driveId).toBe("drive-1");

    const mid = await handlePrepareAskText(deps, "Because growth");
    expect(mid.kind).toBe("complete");
    if (mid.kind === "complete") {
      expect(mid.driveId).toBe("drive-1");
    }
    expect(answers.length).toBe(1);
    expect(getOnboarding()).toEqual({});
  });

  it("accepts dropdown choice by index", async () => {
    const { db, answers } = askStore();
    const { client } = tg();
    const deps = { db, telegram: client, chatId: "1" };
    await startPrepareAsk(deps, "d2", [
      { id: null, label: "City", type: "dropdown", required: true, options: ["BLR", "HYD"] },
    ]);
    const result = await handlePrepareAskChoice(deps, 1);
    expect(result.kind).toBe("complete");
    expect(answers[0]?.value).toBe("HYD");
  });

  it("cancel clears state", async () => {
    const { db, getOnboarding } = askStore();
    const { client } = tg();
    const deps = { db, telegram: client, chatId: "1" };
    await startPrepareAsk(deps, "d3", [
      { id: null, label: "Q", type: "text", required: true, options: [] },
    ]);
    const result = await handlePrepareAskText(deps, "cancel");
    expect(result.kind).toBe("cancelled");
    expect(getOnboarding()).toEqual({});
  });
});
