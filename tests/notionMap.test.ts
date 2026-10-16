import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DriveRow } from "../app/db/drive.ts";
import { driveTitle, mapDriveProperties, readNotionStatus } from "../app/notion/map.ts";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const listFixture = JSON.parse(readFileSync(path.join(fixturesDir, "list.json"), "utf8")) as {
  events: Array<Record<string, unknown>>;
};

function rowFromEvent(event: Record<string, unknown>, overrides: Partial<DriveRow> = {}): DriveRow {
  return {
    id: String(event._id),
    raw_list: event,
    raw_detail: null,
    updated_at_platform: typeof event.updatedAt === "string" ? event.updatedAt : null,
    is_eligible: true,
    deadline: typeof event.deadline === "string" ? event.deadline : null,
    status: "New",
    reminder_sent: false,
    draft_status: null,
    notion_page_id: null,
    pdf_urls: [],
    pdf_text: {},
    company_id: null,
    company_name: typeof event.companyName === "string" ? event.companyName : null,
    company_username: null,
    event_name: typeof event.eventName === "string" ? event.eventName : null,
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    alerted_at: null,
    ...overrides,
  };
}

describe("notion map", () => {
  it("maps title, dates, compensation arrays, and selections[] rounds", () => {
    const event = listFixture.events[0]!;
    const row = rowFromEvent(event);
    const props = mapDriveProperties(row);

    expect(driveTitle(row)).toContain("Deloitte India");
    expect(props.Name).toEqual({
      title: [{ type: "text", text: { content: driveTitle(row) } }],
    });
    expect(props.Status).toEqual({ status: { name: "New" } });
    expect(props.Type).toEqual({
      rich_text: [{ type: "text", text: { content: "Internship + Full Time Employment" } }],
    });
    expect(props.Location).toEqual({
      rich_text: [{ type: "text", text: { content: "Bengaluru" } }],
    });
    expect(props.Stipend).toEqual({
      rich_text: [{ type: "text", text: { content: "25000" } }],
    });
    expect(props.CTC).toEqual({
      rich_text: [{ type: "text", text: { content: "671000" } }],
    });
    const rounds = props.Rounds as { rich_text: Array<{ text: { content: string } }> };
    expect(rounds.rich_text[0]!.text.content).toContain("Technical (Interview)");
    expect(rounds.rich_text[0]!.text.content).toContain("Interview (Interview)");
    expect(props.Deadline).toMatchObject({
      date: { time_zone: "Asia/Kolkata" },
    });
    expect(props.Updated).toMatchObject({
      date: { time_zone: "Asia/Kolkata" },
    });
  });

  it("omits Status when includeStatus is false", () => {
    const row = rowFromEvent(listFixture.events[0]!);
    const props = mapDriveProperties(row, { includeStatus: false });
    expect(props.Status).toBeUndefined();
  });

  it("reads Notion Status from page properties", () => {
    expect(readNotionStatus({ Status: { status: { name: "Interview" } } })).toBe("Interview");
    expect(readNotionStatus({ Status: { status: { name: "Nope" } } })).toBeNull();
  });
});
