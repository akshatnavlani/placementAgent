import { describe, expect, it } from "vitest";
import { istWallToUtc } from "../../app/calendar/parseMailTime.ts";
import { resolveEventTime } from "../../app/calendar/resolveTime.ts";

describe("resolveEventTime", () => {
  const rawDetail = {
    deadline: "2026-11-01T10:00:00.000Z",
    subEvents: [
      {
        name: "Assessment",
        eventDate: "2026-11-22T18:30:00.000Z",
        startTime: "11:00",
        endTime: "12:00",
      },
    ],
  };

  it("prefers mail over subEvents", () => {
    const now = new Date("2026-10-11T06:00:00.000Z");
    const resolved = resolveEventTime({
      roundKey: "assessment",
      subject: "OA",
      body: "Your assessment is Monday 10am.",
      rawDetail,
      now,
    });
    expect(resolved?.source).toBe("mail");
    expect(resolved!.start.toISOString()).not.toBe(istWallToUtc(2026, 11, 22, 11, 0).toISOString());
  });

  it("falls back to subEvents", () => {
    const resolved = resolveEventTime({
      roundKey: "assessment",
      subject: "OA link",
      body: "Complete within 48 hours.",
      rawDetail,
    });
    expect(resolved?.source).toBe("subevent");
    // eventDate 22T18:30Z → IST calendar date 23 Nov
    expect(resolved!.start.toISOString()).toBe(istWallToUtc(2026, 11, 23, 11, 0).toISOString());
  });

  it("ignores deadline and returns null when neither source works", () => {
    const resolved = resolveEventTime({
      roundKey: "interview",
      subject: "Hi",
      body: "No date here",
      rawDetail: { deadline: "2026-11-01T10:00:00.000Z", subEvents: [] },
    });
    expect(resolved).toBeNull();
  });
});
