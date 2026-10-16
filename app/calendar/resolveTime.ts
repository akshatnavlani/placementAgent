import type { CalendarRoundKey } from "../db/calendar.ts";
import { parseMailTime, type ParsedMailTime } from "./parseMailTime.ts";
import { findSubEventTime } from "./subEventTime.ts";

export type ResolvedTime = ParsedMailTime & {
  source: "mail" | "subevent";
  venue?: string;
};

/**
 * Prefer mail datetime → matching subEvents → null. Never uses deadline.
 */
export function resolveEventTime(input: {
  roundKey: CalendarRoundKey;
  subject?: string;
  body?: string;
  rawDetail?: Record<string, unknown> | null;
  now?: Date;
}): ResolvedTime | null {
  const now = input.now ?? new Date();
  const mail = parseMailTime(input.subject ?? "", input.body ?? "", now);
  if (mail) {
    return { ...mail, source: "mail" };
  }
  const sub = findSubEventTime(input.rawDetail, input.roundKey);
  if (sub) {
    return { start: sub.start, end: sub.end, source: "subevent", venue: sub.venue };
  }
  return null;
}
