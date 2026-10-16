import type { CalendarRoundKey } from "../db/calendar.ts";
import { istWallToUtc } from "./parseMailTime.ts";
import { roundKeyFromSubEventName } from "./roundKey.ts";

export type SubEventTime = {
  start: Date;
  end: Date;
  name: string;
  venue?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseClock(raw: unknown): { hour: number; minute: number } | null {
  if (typeof raw !== "string") {
    return null;
  }
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    return null;
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function istDatePartsFromInstant(iso: string): { y: number; m: number; day: number } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    day: Number(parts.day),
  };
}

/**
 * Compose subEvent time: Asia/Kolkata calendar date of eventDate + startTime/endTime wall clocks.
 */
export function composeSubEventTime(sub: Record<string, unknown>): SubEventTime | null {
  const name = typeof sub.name === "string" ? sub.name : "";
  const eventDate = typeof sub.eventDate === "string" ? sub.eventDate : null;
  if (!eventDate) {
    return null;
  }
  const dateParts = istDatePartsFromInstant(eventDate);
  const startClock = parseClock(sub.startTime);
  if (!dateParts || !startClock) {
    return null;
  }
  const start = istWallToUtc(dateParts.y, dateParts.m, dateParts.day, startClock.hour, startClock.minute);
  const endClock = parseClock(sub.endTime);
  const end = endClock
    ? istWallToUtc(dateParts.y, dateParts.m, dateParts.day, endClock.hour, endClock.minute)
    : new Date(start.getTime() + 60 * 60 * 1000);
  const venue = typeof sub.eventVenue === "string" ? sub.eventVenue : undefined;
  return { start, end, name, venue };
}

export function findSubEventTime(
  rawDetail: Record<string, unknown> | null | undefined,
  roundKey: CalendarRoundKey,
): SubEventTime | null {
  if (!rawDetail) {
    return null;
  }
  const list = rawDetail.subEvents;
  if (!Array.isArray(list)) {
    return null;
  }
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) {
      continue;
    }
    const key = roundKeyFromSubEventName(typeof rec.name === "string" ? rec.name : null);
    if (key !== roundKey) {
      continue;
    }
    const composed = composeSubEventTime(rec);
    if (composed) {
      return composed;
    }
  }
  return null;
}

export function listAssessmentInterviewSubEvents(
  rawDetail: Record<string, unknown> | null | undefined,
): Array<{ roundKey: CalendarRoundKey; time: SubEventTime }> {
  if (!rawDetail || !Array.isArray(rawDetail.subEvents)) {
    return [];
  }
  const out: Array<{ roundKey: CalendarRoundKey; time: SubEventTime }> = [];
  const seen = new Set<CalendarRoundKey>();
  for (const item of rawDetail.subEvents) {
    const rec = asRecord(item);
    if (!rec) {
      continue;
    }
    const key = roundKeyFromSubEventName(typeof rec.name === "string" ? rec.name : null);
    if (!key || seen.has(key)) {
      continue;
    }
    const time = composeSubEventTime(rec);
    if (!time) {
      continue;
    }
    seen.add(key);
    out.push({ roundKey: key, time });
  }
  return out;
}
