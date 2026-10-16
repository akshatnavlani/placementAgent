const IST = "Asia/Kolkata";

export type ParsedMailTime = {
  start: Date;
  end: Date;
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function istParts(d: Date): { y: number; m: number; day: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday ?? ""] ?? 0,
  };
}

/** Build a Date for y-m-d H:M in Asia/Kolkata (IST = UTC+5:30, no DST). */
export function istWallToUtc(y: number, m: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(y, m - 1, day, hour, minute) - (5 * 60 + 30) * 60_000);
}

function parseClock(raw: string): { hour: number; minute: number } | null {
  const m = raw
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) {
    return null;
  }
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) {
    hour += 12;
  }
  if (ampm === "am" && hour === 12) {
    hour = 0;
  }
  if (hour > 23 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function nextWeekday(from: Date, targetDow: number): { y: number; m: number; day: number } {
  const p = istParts(from);
  let delta = (targetDow - p.weekday + 7) % 7;
  if (delta === 0) {
    delta = 7;
  }
  // Noon UTC offset approximates IST midday for that calendar delta
  const noon = new Date(Date.UTC(p.y, p.m - 1, p.day, 6, 30) + delta * DAY_MS);
  const np = istParts(noon);
  return { y: np.y, m: np.m, day: np.day };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort extract start/end from subject+body. Returns null when ambiguous.
 * Default duration 1h when end missing.
 */
export function parseMailTime(
  subject: string,
  body: string,
  now: Date = new Date(),
): ParsedMailTime | null {
  const text = `${subject}\n${body}`;

  // ISO-like: 2026-11-22T10:00 or 2026-11-22 10:00
  const iso = text.match(
    /\b(20\d{2})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::\d{2})?)?/i,
  );
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const day = Number(iso[3]);
    const hour = iso[4] != null ? Number(iso[4]) : 10;
    const minute = iso[5] != null ? Number(iso[5]) : 0;
    const start = istWallToUtc(y, m, day, hour, minute);
    return { start, end: new Date(start.getTime() + 60 * 60 * 1000) };
  }

  // "Monday 10am" / "Friday 2pm" / "Monday at 10:00"
  const weekdayClock = text.match(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:\s+at)?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
  );
  if (weekdayClock) {
    const dayName = weekdayClock[1];
    const clockRaw = weekdayClock[2];
    if (dayName && clockRaw) {
      const dow = WEEKDAYS[dayName.toLowerCase()];
      const clock = parseClock(clockRaw);
      if (clock && dow !== undefined) {
        const date = nextWeekday(now, dow);
        const start = istWallToUtc(date.y, date.m, date.day, clock.hour, clock.minute);
        return { start, end: new Date(start.getTime() + 60 * 60 * 1000) };
      }
    }
  }

  // "on 22 Nov at 10:00" / "22 November 2026, 11:00"
  const dayMonth = text.match(
    /\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(?:,?\s*(20\d{2}))?(?:\s*(?:at|,)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?/i,
  );
  if (dayMonth) {
    const months: Record<string, number> = {
      jan: 1,
      january: 1,
      feb: 2,
      february: 2,
      mar: 3,
      march: 3,
      apr: 4,
      april: 4,
      may: 5,
      jun: 6,
      june: 6,
      jul: 7,
      july: 7,
      aug: 8,
      august: 8,
      sep: 9,
      sept: 9,
      september: 9,
      oct: 10,
      october: 10,
      nov: 11,
      november: 11,
      dec: 12,
      december: 12,
    };
    const dayRaw = dayMonth[1];
    const monthRaw = dayMonth[2];
    if (dayRaw && monthRaw) {
      const day = Number(dayRaw);
      const month = months[monthRaw.toLowerCase()];
      const p = istParts(now);
      const y = dayMonth[3] ? Number(dayMonth[3]) : p.y;
      const clock = dayMonth[4] ? parseClock(dayMonth[4]) : { hour: 10, minute: 0 };
      if (month && clock) {
        const start = istWallToUtc(y, month, day, clock.hour, clock.minute);
        return { start, end: new Date(start.getTime() + 60 * 60 * 1000) };
      }
    }
  }

  return null;
}
