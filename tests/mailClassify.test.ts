import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyRecruitmentMail,
  isStrongOfferReason,
  namePresentInText,
  nameTokensFromProfile,
} from "../app/mail/classify.ts";
import {
  isActionableMailClassification,
  looksLikeMarketingNoise,
  shouldProcessPlacementMail,
} from "../app/mail/placementGate.ts";

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
    expect(files.length).toBeGreaterThanOrEqual(16);
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

  it("ignores campus UPO blasts even when body mentions interview", () => {
    const r = classifyRecruitmentMail(load("upo_ignore.json"));
    expect(r.classification).toBe("unresolved");
    expect(r.reason).toBe("campus_upo_blast");
    expect(looksLikeMarketingNoise(load("upo_ignore.json").subject, load("upo_ignore.json").bodyText)).toBe(
      true,
    );
  });

  it("ignores OTP / system noise", () => {
    const r = classifyRecruitmentMail(load("otp_ignore.json"));
    expect(r.classification).toBe("unresolved");
    expect(r.reason).toBe("system_noise");
  });

  it("maps interview-qualified shortlist to interview", () => {
    const r = classifyRecruitmentMail(load("ather_interview_shortlist.json"));
    expect(r.classification).toBe("interview");
    expect(r.reason).toBe("shortlist_interview_qualified");
  });

  it("maps Accenture candidature rejection", () => {
    const r = classifyRecruitmentMail(load("accenture_rejection.json"));
    expect(r.classification).toBe("rejection");
  });

  it("maps assessment invitation", () => {
    const r = classifyRecruitmentMail(load("assessment_invitation.json"));
    expect(r.classification).toBe("assessment");
  });

  it("maps Tejas postponed as reschedule", () => {
    const r = classifyRecruitmentMail(load("tejas_postponed.json"));
    expect(r.classification).toBe("reschedule");
  });

  it("maps strong offer-ack body as offer_received with strong reason", () => {
    const r = classifyRecruitmentMail(load("offer_ack_body.json"));
    expect(r.classification).toBe("offer_received");
    expect(isStrongOfferReason(r.reason)).toBe(true);
    expect(isActionableMailClassification(r)).toBe(true);
  });

  it("treats weak keyword offers as non-actionable", () => {
    const r = classifyRecruitmentMail(load("offer_received.json"));
    expect(r.classification).toBe("offer_received");
    expect(r.reason).toBe("offer_keywords_weak");
    expect(isStrongOfferReason(r.reason)).toBe(false);
    expect(isActionableMailClassification(r)).toBe(false);
  });

  it("notifies PESU cell shortlist without name as shortlist_present", () => {
    const r = classifyRecruitmentMail(load("pesu_cell_shortlist.json"));
    expect(r.classification).toBe("shortlist_present");
    expect(r.reason).toBe("pesu_cell_shortlist");
    expect(r.namePresent).toBe(false);
  });

  it("does not classify bare interview alone outside schedule phrases", () => {
    const r = classifyRecruitmentMail({
      subject: "Company update",
      snippet: "",
      bodyText: "We look forward to the interview experience on campus someday.",
      studentNameTokens: ["ada", "lovelace"],
    });
    expect(r.classification).toBe("unresolved");
  });

  it("extracts name tokens from profile", () => {
    expect(nameTokensFromProfile({ fullName: "Ada Lovelace" })).toEqual(["ada", "lovelace"]);
  });

  it("matches name tokens in text", () => {
    expect(namePresentInText("Ada Lovelace shortlisted", ["ada", "lovelace"])).toBe(true);
    expect(namePresentInText("Alan Turing only", ["ada", "lovelace"])).toBe(false);
  });

  it("gates UPO as marketing noise even with drives present", () => {
    const f = load("upo_ignore.json");
    const classified = classifyRecruitmentMail(f);
    const gate = shouldProcessPlacementMail({
      subject: f.subject,
      bodyText: f.bodyText,
      classified,
      drives: [],
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.reason).toBe("marketing_noise");
    }
  });
});
