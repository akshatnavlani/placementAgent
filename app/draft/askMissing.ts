import { upsertReusableAnswer } from "../db/answer.ts";
import type { DbClient } from "../db/client.ts";
import { clearOnboarding, loadFullProfile, setOnboarding } from "../db/profile.ts";
import type { OnboardingState, PrepareAskField } from "../profile/manual.ts";
import type { TelegramClient } from "../telegram/client.ts";
import { askChoiceKeyboard } from "../telegram/buttons.ts";
import { assertDropdownValue } from "./formatAnswers.ts";
import type { CustomField } from "./payload.ts";

export type AskMissingDeps = {
  db: DbClient;
  telegram: TelegramClient;
  chatId: string;
  log?: { warn?: (obj: Record<string, unknown>, msg?: string) => void };
};

function toAskFields(fields: CustomField[]): PrepareAskField[] {
  return fields.map((f) => ({
    label: f.label,
    type: f.type,
    options: f.options,
  }));
}

function isChoiceField(field: PrepareAskField): boolean {
  const t = field.type?.toLowerCase() ?? "";
  return t === "dropdown" || t === "select" || field.options.length > 0;
}

export async function promptPrepareAskField(
  deps: AskMissingDeps,
  state: OnboardingState,
): Promise<void> {
  const fields = state.ask_fields ?? [];
  const index = state.ask_index ?? 0;
  const field = fields[index];
  if (!field) {
    return;
  }
  const n = index + 1;
  const total = fields.length;
  const header = `Before preparing, answer required field ${n}/${total}:\n${field.label}`;
  if (isChoiceField(field)) {
    await deps.telegram.sendMessage(
      deps.chatId,
      `${header}\nPick one option (or send cancel).`,
      askChoiceKeyboard(field.options),
    );
  } else {
    await deps.telegram.sendMessage(deps.chatId, `${header}\nReply with your answer (or cancel).`);
  }
}

export async function startPrepareAsk(
  deps: AskMissingDeps,
  driveId: string,
  missing: CustomField[],
): Promise<void> {
  const state: OnboardingState = {
    mode: "prepare_ask",
    step: "field",
    expect: missing[0] && isChoiceField(toAskFields(missing)[0]!) ? "choice" : "text",
    driveId,
    ask_fields: toAskFields(missing),
    ask_index: 0,
  };
  await setOnboarding(deps.db, state);
  await promptPrepareAskField(deps, state);
}

export function isPrepareAskActive(state: OnboardingState | undefined): boolean {
  return state?.mode === "prepare_ask" && Boolean(state.driveId) && (state.ask_fields?.length ?? 0) > 0;
}

export async function cancelPrepareAsk(deps: AskMissingDeps): Promise<void> {
  await clearOnboarding(deps.db);
  await deps.telegram.sendMessage(deps.chatId, "Prepare cancelled. Tap Prepare again when ready.");
}

async function advanceOrFinish(
  deps: AskMissingDeps,
  state: OnboardingState,
): Promise<"more" | "done"> {
  const nextIndex = (state.ask_index ?? 0) + 1;
  const fields = state.ask_fields ?? [];
  if (nextIndex >= fields.length) {
    await clearOnboarding(deps.db);
    return "done";
  }
  const nextField = fields[nextIndex]!;
  const next: OnboardingState = {
    ...state,
    ask_index: nextIndex,
    expect: isChoiceField(nextField) ? "choice" : "text",
  };
  await setOnboarding(deps.db, next);
  await promptPrepareAskField(deps, next);
  return "more";
}

export type AskHandleResult =
  | { kind: "ignored" }
  | { kind: "cancelled" }
  | { kind: "progress" }
  | { kind: "complete"; driveId: string }
  | { kind: "invalid"; reason: string };

async function recordAnswer(
  deps: AskMissingDeps,
  state: OnboardingState,
  value: string,
): Promise<AskHandleResult> {
  const fields = state.ask_fields ?? [];
  const index = state.ask_index ?? 0;
  const field = fields[index];
  const driveId = state.driveId;
  if (!field || !driveId) {
    return { kind: "ignored" };
  }

  const check = assertDropdownValue(field, value);
  if (!check.ok) {
    await deps.telegram.sendMessage(deps.chatId, check.reason);
    return { kind: "invalid", reason: check.reason };
  }

  await upsertReusableAnswer(deps.db, {
    labelDisplay: field.label,
    value,
    approved: true,
  });
  await deps.telegram.sendMessage(deps.chatId, `Saved: ${field.label}`);

  const next = await advanceOrFinish(deps, state);
  if (next === "done") {
    return { kind: "complete", driveId };
  }
  return { kind: "progress" };
}

export async function handlePrepareAskText(
  deps: AskMissingDeps,
  text: string,
): Promise<AskHandleResult> {
  const profile = await loadFullProfile(deps.db);
  if (!isPrepareAskActive(profile?.onboarding)) {
    return { kind: "ignored" };
  }
  const state = profile!.onboarding;
  const trimmed = text.trim();
  if (/^\s*cancel\s*$/i.test(trimmed)) {
    await cancelPrepareAsk(deps);
    return { kind: "cancelled" };
  }

  const fields = state.ask_fields ?? [];
  const field = fields[state.ask_index ?? 0];
  if (!field) {
    return { kind: "ignored" };
  }
  if (isChoiceField(field)) {
    // Allow typing an option as text as well as tapping the keyboard.
    return recordAnswer(deps, state, trimmed);
  }
  if (!trimmed) {
    await deps.telegram.sendMessage(deps.chatId, "Send a non-empty answer, or cancel.");
    return { kind: "invalid", reason: "empty" };
  }
  return recordAnswer(deps, state, trimmed);
}

export async function handlePrepareAskChoice(
  deps: AskMissingDeps,
  optionIndex: number,
): Promise<AskHandleResult> {
  const profile = await loadFullProfile(deps.db);
  if (!isPrepareAskActive(profile?.onboarding)) {
    return { kind: "ignored" };
  }
  const state = profile!.onboarding;
  const field = state.ask_fields?.[state.ask_index ?? 0];
  if (!field) {
    return { kind: "ignored" };
  }
  const value = field.options[optionIndex];
  if (value === undefined) {
    await deps.telegram.sendMessage(deps.chatId, "That option is gone. Pick again or cancel.");
    return { kind: "invalid", reason: "bad_index" };
  }
  return recordAnswer(deps, state, value);
}
