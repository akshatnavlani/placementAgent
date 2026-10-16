import { describe, expect, it } from "vitest";
import { buildEligibilityBody } from "../app/placement/eligibilityBody.ts";

describe("buildEligibilityBody", () => {
  it("keeps real zeros and converts numeric strings", () => {
    const { body, omitted } = buildEligibilityBody({
      batch: "2027",
      department: "CSE",
      graduateDegree: "BTech",
      currentCGPA: "8.5",
      tenthPercentage: 95,
      twelfthPercentage: "90.0",
      activeBacklogs: 0,
    });
    expect(body).toEqual({
      batch: 2027,
      department: "CSE",
      graduateDegree: "BTech",
      currentCGPA: 8.5,
      tenthPercentage: 95,
      twelfthPercentage: 90,
      activeBacklogs: 0,
    });
    expect(omitted).toEqual([]);
  });

  it("omits missing and unparseable fields by name only", () => {
    const { body, omitted } = buildEligibilityBody({
      batch: "not-a-number",
      department: "",
      currentCGPA: null,
      activeBacklogs: 0,
      ugCGPA: 9,
      placementTier: "A",
    });
    expect(body).toEqual({ activeBacklogs: 0 });
    expect(omitted.sort()).toEqual(
      ["batch", "currentCGPA", "department", "graduateDegree", "tenthPercentage", "twelfthPercentage"].sort(),
    );
    expect(body).not.toHaveProperty("ugCGPA");
    expect(body).not.toHaveProperty("placementTier");
  });

  it("never copies forbidden defaults from the mobile app body", () => {
    const { body } = buildEligibilityBody({
      batch: 2027,
      department: "CSE",
      graduateDegree: "BTech",
      currentCGPA: 8,
      tenthPercentage: 90,
      twelfthPercentage: 90,
      activeBacklogs: 0,
      ugCGPA: 0,
      placementTier: "1",
      internshipOfferedAt: null,
      summerInternshipOfferedAt: null,
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        "activeBacklogs",
        "batch",
        "currentCGPA",
        "department",
        "graduateDegree",
        "tenthPercentage",
        "twelfthPercentage",
      ].sort(),
    );
  });
});
