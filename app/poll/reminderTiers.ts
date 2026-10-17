/** Deadline reminder thresholds, largest window first. */
export const REMINDER_TIERS = [
  { id: "12h", ms: 12 * 60 * 60 * 1000, label: "under 12 hours" },
  { id: "6h", ms: 6 * 60 * 60 * 1000, label: "under 6 hours" },
  { id: "3h", ms: 3 * 60 * 60 * 1000, label: "under 3 hours" },
  { id: "1h", ms: 60 * 60 * 1000, label: "under 1 hour" },
  { id: "30m", ms: 30 * 60 * 1000, label: "under 30 minutes" },
] as const;

export type ReminderTierId = (typeof REMINDER_TIERS)[number]["id"];

export function parseReminderTiers(value: unknown): ReminderTierId[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowed = new Set(REMINDER_TIERS.map((t) => t.id));
  const out: ReminderTierId[] = [];
  for (const item of value) {
    if (typeof item === "string" && allowed.has(item as ReminderTierId)) {
      out.push(item as ReminderTierId);
    }
  }
  return out;
}

/**
 * Smallest tier the remaining time has entered that is not yet sent.
 * Returns null if past deadline, not yet in any window, or all due tiers already sent.
 */
export function nextReminderTierToSend(
  deadlineIso: string | null,
  alreadySent: readonly string[],
  now: Date = new Date(),
): ReminderTierId[] {
  if (!deadlineIso) {
    return [];
  }
  const ms = Date.parse(deadlineIso);
  if (!Number.isFinite(ms)) {
    return [];
  }
  const remaining = ms - now.getTime();
  if (remaining <= 0) {
    return [];
  }
  const sent = new Set(alreadySent);
  const due: ReminderTierId[] = [];
  for (const tier of REMINDER_TIERS) {
    if (remaining < tier.ms && !sent.has(tier.id)) {
      due.push(tier.id);
    }
  }
  return due;
}

export function tierLabel(id: ReminderTierId): string {
  return REMINDER_TIERS.find((t) => t.id === id)?.label ?? id;
}

/** On first discovery inside a window, mark all larger tiers as already "sent" so we only fire the tightest. */
export function tiersImpliedByRemaining(remainingMs: number): ReminderTierId[] {
  if (remainingMs <= 0) {
    return [];
  }
  return REMINDER_TIERS.filter((t) => remainingMs < t.ms).map((t) => t.id);
}
