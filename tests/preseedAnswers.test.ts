import { describe, expect, it } from "vitest";
import { listAnswers, preseedFromProfile, upsertReusableAnswer } from "../app/db/answer.ts";
import type { FullProfile } from "../app/db/profile.ts";

function answerStore() {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    from(table: string) {
      if (table !== "answer") {
        throw new Error(`unexpected ${table}`);
      }
      return {
        select: () => ({
          then: (resolve: (v: { data: typeof rows; error: null }) => unknown) =>
            Promise.resolve(resolve({ data: rows, error: null })),
        }),
        insert: async (payload: Record<string, unknown>) => {
          rows.push({ id: `id-${rows.length + 1}`, ...payload });
          return { error: null };
        },
        update: (payload: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            const idx = rows.findIndex((r) => r.id === id);
            if (idx >= 0) {
              rows[idx] = { ...rows[idx], ...payload };
            }
            return { error: null };
          },
        }),
      };
    },
  };
  return { db: db as never, rows };
}

const baseProfile: FullProfile = {
  studentId: "PES1UG00FAKE",
  platform: {
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "999",
    dob: "2000-01-01",
    department: "CSE",
    batch: 2027,
    graduateDegree: "BTech",
    currentCGPA: 9.2,
  },
  platformSyncedAt: null,
  manual: {
    jee: { percentile: "99" },
    coding: { platform: "CF", url: "https://cf", rating: "1500", contests: "10" },
    awards: ["Hackathon 1st"],
    certifications: ["Postman API"],
  },
  canonicalLatex:
    "\\section{Technical Skills}\\textbf{Languages:} Python, Go\\textbf{Tools:} Docker",
  canonicalLatexUpdatedAt: null,
  onboarding: {},
};

describe("preseedFromProfile", () => {
  it("seeds name email academics and manual without phone or dob", async () => {
    const { db, rows } = answerStore();
    await preseedFromProfile(db, baseProfile);
    const labels = rows.map((r) => String(r.label_display));
    expect(labels).toContain("Full Name");
    expect(labels).toContain("Email");
    expect(labels).toContain("CGPA");
    expect(labels).toContain("JEE Percentile");
    expect(labels).toContain("Coding Platform");
    expect(labels).toContain("Awards");
    expect(labels).toContain("Certifications");
    expect(labels).toContain("Awards & Certifications");
    expect(labels).toContain("Technologies Known");
    expect(labels.join(" ")).not.toMatch(/phone|dob|birth/i);
    expect(rows.every((r) => !String(r.value).includes("999"))).toBe(true);
  });

  it("suggests combined awards and certifications for drive labels", async () => {
    const { suggestAnswerFromProfile } = await import("../app/db/answer.ts");
    const value = suggestAnswerFromProfile("Awards & Certifications", baseProfile);
    expect(value).toContain("Hackathon 1st");
    expect(value).toContain("Postman API");
  });

  it("does not overwrite an existing approved answer", async () => {
    const { db, rows } = answerStore();
    await upsertReusableAnswer(db, {
      labelDisplay: "Email",
      value: "custom@example.com",
      approved: true,
    });
    await preseedFromProfile(db, baseProfile);
    const email = rows.find((r) => r.label_normalized === "email");
    expect(email?.value).toBe("custom@example.com");
    const listed = await listAnswers(db);
    expect(listed.find((a) => a.label_normalized === "email")?.value).toBe("custom@example.com");
  });
});
