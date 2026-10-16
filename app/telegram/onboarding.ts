import { preseedFromProfile } from "../db/answer.ts";
import type { DbClient } from "../db/client.ts";
import {
  clearOnboarding,
  loadFullProfile,
  replaceManual,
  setCanonicalLatex,
  setOnboarding,
  type FullProfile,
} from "../db/profile.ts";
import { summarizeGithubRepo } from "../profile/githubSummary.ts";
import type { ManualProfile, OnboardingState } from "../profile/manual.ts";
import { deepMergeManual } from "../profile/manual.ts";
import { formatProfileSummary } from "../profile/summary.ts";
import type { TelegramClient } from "./client.ts";

export const MAX_LATEX_BYTES = 200_000;

export type OnboardingDeps = {
  db: DbClient;
  telegram: TelegramClient;
  chatId: string;
  fetch?: typeof globalThis.fetch;
  log?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
};

export function profileMenuKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "Redo all", callback_data: "prof:redo" },
        { text: "Replace LaTeX", callback_data: "prof:latex" },
      ],
      [{ text: "Add GitHub", callback_data: "prof:github" }],
    ],
  };
}

export function reviewKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "Looks good", callback_data: "prof:ok" },
        { text: "Redo from start", callback_data: "prof:redo" },
      ],
    ],
  };
}

export function githubApproveKeyboard(index: number): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `g:ok:${index}` },
        { text: "Reject", callback_data: `g:no:${index}` },
      ],
    ],
  };
}

const STEPS = [
  "jee_percentile",
  "jee_rank",
  "coding_platform",
  "coding_url",
  "coding_rating",
  "coding_contests",
  "certifications",
  "awards",
  "projects",
  "latex",
  "github",
  "review",
] as const;

type Step = (typeof STEPS)[number];

function promptFor(step: Step): string {
  switch (step) {
    case "jee_percentile":
      return "JEE percentile? (or skip)";
    case "jee_rank":
      return "JEE rank? (or skip)";
    case "coding_platform":
      return "Coding platform (e.g. Codeforces, LeetCode)? (or skip)";
    case "coding_url":
      return "Coding profile URL? (or skip)";
    case "coding_rating":
      return "Coding rating? (or skip)";
    case "coding_contests":
      return "Contest results / highlights? (or skip)";
    case "certifications":
      return "Certifications (comma-separated, or none)?";
    case "awards":
      return "Awards (comma-separated, or none)?";
    case "projects":
      return "Project links (one per line, then send done)?";
    case "latex":
      return "Send your canonical resume as a .tex file, or paste LaTeX. (PDF not accepted.)";
    case "github":
      return "Optional GitHub repo URLs (one per line, then done). Or done to skip.";
    case "review":
      return "Review your profile below.";
  }
}

function isSkip(text: string): boolean {
  return /^\s*(skip|none)\s*$/i.test(text);
}

function parseList(text: string): string[] {
  if (isSkip(text) || /^\s*none\s*$/i.test(text)) {
    return [];
  }
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function saveOnboarding(deps: OnboardingDeps, state: OnboardingState): Promise<void> {
  await setOnboarding(deps.db, state);
}

async function askStep(deps: OnboardingDeps, step: Step): Promise<void> {
  await deps.telegram.sendMessage(deps.chatId, promptFor(step));
}

export async function startWizard(
  deps: OnboardingDeps,
  mode: "fresh" | "redo" = "fresh",
): Promise<void> {
  const profile = await loadFullProfile(deps.db);
  if (!profile) {
    await deps.telegram.sendMessage(deps.chatId, "No platform profile yet. Wait for a successful poll/login.");
    return;
  }
  const draft: ManualProfile = mode === "redo" ? {} : { ...profile.manual };
  const state: OnboardingState = {
    step: "jee_percentile",
    expect: "text",
    mode,
    draft_manual: draft,
    draft_latex: mode === "redo" ? undefined : (profile.canonicalLatex ?? undefined),
    github_pending: [],
    github_queue: [],
  };
  await saveOnboarding(deps, state);
  await deps.telegram.sendMessage(
    deps.chatId,
    mode === "redo"
      ? "Starting profile redo. Send cancel anytime to abort without saving."
      : "Starting profile setup. Send cancel anytime to abort. skip leaves a field blank.",
  );
  await askStep(deps, "jee_percentile");
}

export async function startLatexOnly(deps: OnboardingDeps): Promise<void> {
  const profile = await loadFullProfile(deps.db);
  if (!profile) {
    await deps.telegram.sendMessage(deps.chatId, "No platform profile yet.");
    return;
  }
  await saveOnboarding(deps, {
    step: "latex",
    expect: "latex",
    mode: "latex",
    draft_manual: profile.manual,
    draft_latex: profile.canonicalLatex ?? undefined,
  });
  await askStep(deps, "latex");
}

export async function startGithubOnly(deps: OnboardingDeps): Promise<void> {
  const profile = await loadFullProfile(deps.db);
  if (!profile) {
    await deps.telegram.sendMessage(deps.chatId, "No platform profile yet.");
    return;
  }
  await saveOnboarding(deps, {
    step: "github",
    expect: "text",
    mode: "github",
    draft_manual: profile.manual,
    draft_latex: profile.canonicalLatex ?? undefined,
    github_pending: [],
    github_queue: [],
  });
  await askStep(deps, "github");
}

export async function showProfileMenu(deps: OnboardingDeps): Promise<void> {
  const profile = await loadFullProfile(deps.db);
  if (!profile) {
    await deps.telegram.sendMessage(deps.chatId, "No platform profile yet. Wait for a successful poll/login.");
    return;
  }
  const hasManual =
    Boolean(profile.manual.jee || profile.manual.coding) ||
    (profile.manual.projects?.length ?? 0) > 0 ||
    Boolean(profile.canonicalLatex);
  if (!hasManual && !profile.canonicalLatex) {
    await startWizard(deps, "fresh");
    return;
  }
  await deps.telegram.sendMessage(deps.chatId, formatProfileSummary(profile), profileMenuKeyboard());
}

export async function cancelOnboarding(deps: OnboardingDeps): Promise<void> {
  await clearOnboarding(deps.db);
  await deps.telegram.sendMessage(deps.chatId, "Profile setup cancelled. Nothing new was saved.");
}

async function commitLooksGood(deps: OnboardingDeps, state: OnboardingState): Promise<void> {
  const draft = state.draft_manual ?? {};
  if (state.mode === "latex") {
    if (state.draft_latex && state.draft_latex.trim()) {
      await setCanonicalLatex(deps.db, state.draft_latex);
    }
  } else if (state.mode === "github") {
    await replaceManual(deps.db, draft);
  } else {
    await replaceManual(deps.db, draft);
    if (state.draft_latex && state.draft_latex.trim()) {
      await setCanonicalLatex(deps.db, state.draft_latex);
    }
  }
  await clearOnboarding(deps.db);
  const profile = await loadFullProfile(deps.db);
  if (profile) {
    await preseedFromProfile(deps.db, profile);
  }
  await deps.telegram.sendMessage(
    deps.chatId,
    "Profile saved. Run /profile anytime to change it.",
  );
}

async function goReview(deps: OnboardingDeps, state: OnboardingState): Promise<void> {
  const next: OnboardingState = { ...state, step: "review", expect: "review" };
  await saveOnboarding(deps, next);
  const preview: FullProfile = {
    studentId: (await loadFullProfile(deps.db))?.studentId ?? "?",
    platform: {},
    platformSyncedAt: null,
    manual: next.draft_manual ?? {},
    canonicalLatex: next.draft_latex ?? null,
    canonicalLatexUpdatedAt: null,
    onboarding: next,
  };
  await deps.telegram.sendMessage(deps.chatId, formatProfileSummary(preview), reviewKeyboard());
}

function advance(step: Step): Step | null {
  const idx = STEPS.indexOf(step);
  if (idx < 0 || idx >= STEPS.length - 1) {
    return null;
  }
  return STEPS[idx + 1]!;
}

export async function handleOnboardingText(deps: OnboardingDeps, text: string): Promise<boolean> {
  const profile = await loadFullProfile(deps.db);
  if (!profile?.onboarding.step) {
    return false;
  }
  const state = { ...profile.onboarding };
  const step = state.step as Step;

  if (/^\s*cancel\s*$/i.test(text)) {
    await cancelOnboarding(deps);
    return true;
  }

  if (step === "review") {
    await deps.telegram.sendMessage(deps.chatId, "Tap Looks good or Redo from start.");
    return true;
  }

  let draft = state.draft_manual ?? {};

  if (step === "jee_percentile") {
    if (!isSkip(text)) {
      draft = deepMergeManual(draft, { jee: { percentile: text.trim() } });
    }
  } else if (step === "jee_rank") {
    if (!isSkip(text)) {
      draft = deepMergeManual(draft, { jee: { rank: text.trim() } });
    }
  } else if (step === "coding_platform") {
    if (!isSkip(text)) {
      draft = deepMergeManual(draft, { coding: { platform: text.trim() } });
    }
  } else if (step === "coding_url") {
    if (!isSkip(text)) {
      draft = deepMergeManual(draft, { coding: { url: text.trim() } });
    }
  } else if (step === "coding_rating") {
    if (!isSkip(text)) {
      draft = deepMergeManual(draft, { coding: { rating: text.trim() } });
    }
  } else if (step === "coding_contests") {
    if (!isSkip(text)) {
      draft = deepMergeManual(draft, { coding: { contests: text.trim() } });
    }
  } else if (step === "certifications") {
    draft = { ...draft, certifications: parseList(text) };
  } else if (step === "awards") {
    draft = { ...draft, awards: parseList(text) };
  } else if (step === "projects") {
    if (!/^\s*done\s*$/i.test(text)) {
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const projects = [...(draft.projects ?? [])];
      for (const line of lines) {
        if (/^https?:\/\//i.test(line)) {
          projects.push({ name: line, url: line });
        } else {
          projects.push({ name: line });
        }
      }
      draft = { ...draft, projects };
      state.draft_manual = draft;
      await saveOnboarding(deps, state);
      await deps.telegram.sendMessage(deps.chatId, "Added. More links, or send done.");
      return true;
    }
  } else if (step === "latex") {
    if (isSkip(text) && state.mode === "latex") {
      await clearOnboarding(deps.db);
      await deps.telegram.sendMessage(deps.chatId, "LaTeX unchanged.");
      return true;
    }
    if (text.trim().length < 20 && !text.includes("\\")) {
      await deps.telegram.sendMessage(
        deps.chatId,
        "That does not look like LaTeX. Send a .tex file or paste the source.",
      );
      return true;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_LATEX_BYTES) {
      await deps.telegram.sendMessage(deps.chatId, "LaTeX too large (max 200 KB).");
      return true;
    }
    state.draft_latex = text;
    state.draft_manual = draft;
    if (state.mode === "latex") {
      await setCanonicalLatex(deps.db, text);
      await clearOnboarding(deps.db);
      await deps.telegram.sendMessage(deps.chatId, "Canonical LaTeX updated.");
      return true;
    }
    await saveOnboarding(deps, state);
    const next = advance(step);
    if (next) {
      state.step = next;
      await saveOnboarding(deps, state);
      await askStep(deps, next);
    }
    return true;
  } else if (step === "github") {
    if (!/^\s*done\s*$/i.test(text)) {
      const urls = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^https?:\/\//i.test(l));
      if (urls.length === 0) {
        await deps.telegram.sendMessage(deps.chatId, "Send GitHub URLs (one per line) or done.");
        return true;
      }
      state.github_queue = [...(state.github_queue ?? []), ...urls];
      state.draft_manual = draft;
      await saveOnboarding(deps, state);
      await processGithubQueue(deps, state);
      return true;
    }
    // done
    state.draft_manual = draft;
    if (state.mode === "github") {
      await replaceManual(deps.db, draft);
      await clearOnboarding(deps.db);
      const latest = await loadFullProfile(deps.db);
      if (latest) {
        await preseedFromProfile(deps.db, latest);
      }
      await deps.telegram.sendMessage(deps.chatId, "GitHub projects updated.");
      return true;
    }
    await goReview(deps, state);
    return true;
  }

  state.draft_manual = draft;
  const next = advance(step);
  if (!next) {
    await goReview(deps, state);
    return true;
  }
  // latex-only / github-only modes jump differently — handled above
  if (state.mode === "latex" || state.mode === "github") {
    await saveOnboarding(deps, state);
    return true;
  }
  state.step = next;
  state.expect = next === "latex" ? "latex" : "text";
  await saveOnboarding(deps, state);
  await askStep(deps, next);
  return true;
}

async function processGithubQueue(deps: OnboardingDeps, state: OnboardingState): Promise<void> {
  const queue = state.github_queue ?? [];
  if (queue.length === 0) {
    return;
  }
  const url = queue[0]!;
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const result = await summarizeGithubRepo(url, fetchImpl);
  if (!result.ok) {
    await deps.telegram.sendMessage(deps.chatId, `Could not read ${url}: ${result.reason}`);
    state.github_queue = queue.slice(1);
    await saveOnboarding(deps, state);
    if ((state.github_queue?.length ?? 0) > 0) {
      await processGithubQueue(deps, state);
    } else {
      await deps.telegram.sendMessage(deps.chatId, "More GitHub URLs, or done.");
    }
    return;
  }
  const pending = [...(state.github_pending ?? []), { url, summary: result.summary }];
  const index = pending.length - 1;
  state.github_pending = pending;
  state.github_queue = queue.slice(1);
  await saveOnboarding(deps, state);
  await deps.telegram.sendMessage(
    deps.chatId,
    `GitHub summary for ${url}:\n\n${result.summary}`,
    githubApproveKeyboard(index),
  );
}

export async function handleGithubCallback(
  deps: OnboardingDeps,
  kind: "ok" | "no",
  index: number,
): Promise<void> {
  const profile = await loadFullProfile(deps.db);
  if (!profile?.onboarding.step) {
    await deps.telegram.sendMessage(deps.chatId, "No pending GitHub approval.");
    return;
  }
  const state = { ...profile.onboarding };
  const pending = [...(state.github_pending ?? [])];
  const item = pending[index];
  if (!item) {
    await deps.telegram.sendMessage(deps.chatId, "That GitHub item is gone.");
    return;
  }
  if (kind === "ok") {
    const draft = state.draft_manual ?? {};
    const projects = [...(draft.projects ?? []), { name: item.url, url: item.url, blurb: item.summary }];
    state.draft_manual = { ...draft, projects };
  }
  // Mark processed by clearing summary (keep slot for index stability) or splice
  pending[index] = { url: item.url, summary: kind === "ok" ? "[approved]" : "[rejected]" };
  state.github_pending = pending;
  await saveOnboarding(deps, state);
  await deps.telegram.sendMessage(
    deps.chatId,
    kind === "ok" ? "Approved into profile draft." : "Rejected — not added.",
  );
  if ((state.github_queue?.length ?? 0) > 0) {
    await processGithubQueue(deps, state);
  } else {
    await deps.telegram.sendMessage(deps.chatId, "More GitHub URLs, or done.");
  }
}

export async function handleProfileCallback(
  deps: OnboardingDeps,
  action: "redo" | "latex" | "github" | "ok",
): Promise<void> {
  if (action === "redo") {
    await startWizard(deps, "redo");
    return;
  }
  if (action === "latex") {
    await startLatexOnly(deps);
    return;
  }
  if (action === "github") {
    await startGithubOnly(deps);
    return;
  }
  // ok = Looks good
  const profile = await loadFullProfile(deps.db);
  if (!profile?.onboarding.step) {
    await deps.telegram.sendMessage(deps.chatId, "Nothing to confirm.");
    return;
  }
  await commitLooksGood(deps, profile.onboarding);
}

export async function handleLatexDocument(
  deps: OnboardingDeps,
  latex: string,
): Promise<boolean> {
  const profile = await loadFullProfile(deps.db);
  if (profile?.onboarding.step !== "latex" && profile?.onboarding.mode !== "latex") {
    return false;
  }
  if (Buffer.byteLength(latex, "utf8") > MAX_LATEX_BYTES) {
    await deps.telegram.sendMessage(deps.chatId, "LaTeX too large (max 200 KB).");
    return true;
  }
  const state = { ...profile!.onboarding, draft_latex: latex };
  if (state.mode === "latex") {
    await setCanonicalLatex(deps.db, latex);
    await clearOnboarding(deps.db);
    await deps.telegram.sendMessage(deps.chatId, "Canonical LaTeX updated.");
    return true;
  }
  state.step = "github";
  state.expect = "text";
  await saveOnboarding(deps, state);
  await deps.telegram.sendMessage(deps.chatId, `Stored LaTeX (${latex.length} chars).`);
  await askStep(deps, "github");
  return true;
}

export function isProfileCommand(text: string): { kind: "menu" | "redo" | "latex" } | null {
  const t = text.trim();
  if (/^\/?profile\s+redo\s*$/i.test(t)) {
    return { kind: "redo" };
  }
  if (/^\/?profile\s+latex\s*$/i.test(t)) {
    return { kind: "latex" };
  }
  if (/^\/?(start|profile|onboarding)\s*$/i.test(t)) {
    return { kind: "menu" };
  }
  return null;
}
