import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { istWallToUtc } from "../../app/calendar/parseMailTime.ts";
import {
  composeSubEventTime,
  findSubEventTime,
  listAssessmentInterviewSubEvents,
} from "../../app/calendar/subEventTime.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const detail = JSON.parse(
  readFileSync(join(fixtureDir, "detail-fidelity.json"), "utf8"),
) as Record<string, unknown>;

describe("subEventTime", () => {
  it("composes Assessment on IST date of eventDate (22T18:30Z → 23 Nov IST) at 11:00–12:00", () => {
    const time = findSubEventTime(detail, "assessment");
    expect(time).not.toBeNull();
    // 2026-11-22T18:30:00.000Z is 2026-11-23 00:00 Asia/Kolkata
    const expectedStart = istWallToUtc(2026, 11, 23, 11, 0);
    const expectedEnd = istWallToUtc(2026, 11, 23, 12, 0);
    expect(time!.start.toISOString()).toBe(expectedStart.toISOString());
    expect(time!.end.toISOString()).toBe(expectedEnd.toISOString());
    expect(time!.venue).toBe("GJBC");
  });

  it("ignores eventDate clock portion; uses IST calendar date + startTime wall clock", () => {
    const subs = detail.subEvents as Record<string, unknown>[];
    const ppt = composeSubEventTime(subs[0]!);
    const assessment = composeSubEventTime(subs[1]!);
    expect(ppt!.start.toISOString()).toBe(istWallToUtc(2026, 11, 23, 10, 0).toISOString());
    expect(assessment!.start.toISOString()).toBe(istWallToUtc(2026, 11, 23, 11, 0).toISOString());
  });

  it("lists only assessment/interview (skips PPT)", () => {
    const list = listAssessmentInterviewSubEvents(detail);
    expect(list.map((x) => x.roundKey)).toEqual(["assessment"]);
  });
});
