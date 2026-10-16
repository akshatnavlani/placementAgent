import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyRecruitmentMail,
  namePresentInText,
  nameTokensFromProfile,
} from "../app/mail/classify.ts";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mail");

type Fixture = {
  subject: string;
  snippet: string;
  bodyText: string;
  studentNameTokens: string[];
};

function load(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as Fixture;
}

describe("classifyRecruitmentMail", () => {
  it("loads all mail fixtures", () => {
    const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it("detects shortlist with name present", () => {
    const f = load("shortlist_present.json");
    const r = classifyRecruitmentMail(f);
    expect(r.classification).toBe("shortlist_present");
    expect(r.confidence).toBe("high");
    expect(r.namePresent).toBe(true);
  });

  it("detects complete shortlist without name as shortlist_absent", () => {
    const f = load("shortlist_absent_complete.json");
    const r = classifyRecruitmentMail(f);
    expect(r.classification).toBe("shortlist_absent");
    expect(r.confidence).toBe("high");
    expect(r.listComplete).toBe(true);
    expect(r.namePresent).toBe(false);
  });

  it("marks incomplete shortlist without name as low-confidence absent", () => {
    const f = load("shortlist_incomplete.json");
    const r = classifyRecruitmentMail(f);
    expect(r.classification).toBe("shortlist_absent");
    expect(r.listComplete).toBe(false);
    expect(r.confidence).toBe("low");
  });

  it("classifies assessment", () => {
    const f = load("assessment.json");
    expect(classifyRecruitmentMail(f).classification).toBe("assessment");
  });

  it("classifies interview", () => {
    const f = load("interview.json");
    expect(classifyRecruitmentMail(f).classification).toBe("interview");
  });

  it("classifies rejection", () => {
    const f = load("rejection.json");
    expect(classifyRecruitmentMail(f).classification).toBe("rejection");
  });

  it("classifies offer subtypes", () => {
    expect(classifyRecruitmentMail(load("offer_received.json")).classification).toBe("offer_received");
    expect(classifyRecruitmentMail(load("offer_accepted.json")).classification).toBe("offer_accepted");
    expect(classifyRecruitmentMail(load("offer_confirmed.json")).classification).toBe("offer_confirmed");
  });

  it("classifies reschedule", () => {
    expect(classifyRecruitmentMail(load("reschedule.json")).classification).toBe("reschedule");
  });

  it("extracts name tokens from profile", () => {
    expect(nameTokensFromProfile({ fullName: "Ada Lovelace" })).toEqual(["ada", "lovelace"]);
  });

  it("matches name tokens in text", () => {
    expect(namePresentInText("Ada Lovelace shortlisted", ["ada", "lovelace"])).toBe(true);
    expect(namePresentInText("Alan Turing only", ["ada", "lovelace"])).toBe(false);
  });
});
