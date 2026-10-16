import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMailTime } from "../../app/calendar/parseMailTime.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/mail");

function loadMail(name: string): { subject: string; bodyText: string } {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as {
    subject: string;
    bodyText: string;
  };
}

describe("parseMailTime", () => {
  it("parses interview fixture Monday 10am", () => {
    const mail = loadMail("interview.json");
    // Fixed "now" on a Sunday before that Monday: 2026-10-11
    const now = new Date("2026-10-11T06:00:00.000Z");
    const parsed = parseMailTime(mail.subject, mail.bodyText, now);
    expect(parsed).not.toBeNull();
    expect(parsed!.end.getTime() - parsed!.start.getTime()).toBe(60 * 60 * 1000);
    // Monday 10:00 IST
    const ist = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed!.start);
    expect(ist).toMatch(/Mon/);
    expect(ist).toMatch(/10:00/);
  });

  it("parses reschedule fixture Friday 2pm", () => {
    const mail = loadMail("reschedule.json");
    const now = new Date("2026-10-12T06:00:00.000Z"); // Monday
    const parsed = parseMailTime(mail.subject, mail.bodyText, now);
    expect(parsed).not.toBeNull();
    const ist = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed!.start);
    expect(ist).toMatch(/Fri/);
    expect(ist).toMatch(/14:00/);
  });

  it("returns null when ambiguous", () => {
    expect(parseMailTime("Hello", "Please complete within 48 hours.")).toBeNull();
  });
});
