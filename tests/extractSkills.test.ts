import { describe, expect, it } from "vitest";
import {
  extractSkillsFromLatex,
  formatSkillsAnswer,
  isTechnologyFieldLabel,
} from "../app/profile/extractSkills.ts";
import { suggestAnswerFromProfile } from "../app/db/answer.ts";
import type { FullProfile } from "../app/db/profile.ts";

const sample = String.raw`
\section{Experience}
Foo
\section{Technical Skills}
\begin{onecolentry}
\textbf{Languages:} Python, JavaScript, Go
\end{onecolentry}
\begin{onecolentry}
\textbf{Frontend \& Backend:} React, Next.js, Node.js
\end{onecolentry}
\section{Projects}
Bar
`;

describe("extractSkillsFromLatex", () => {
  it("reads bold skill lines from the Technical Skills section", () => {
    const skills = extractSkillsFromLatex(sample);
    expect(skills).toEqual(
      expect.arrayContaining(["Python", "JavaScript", "Go", "React", "Next.js", "Node.js"]),
    );
    expect(skills.join(" ")).not.toMatch(/Experience|Projects|Foo|Bar/);
  });

  it("formats a comma list", () => {
    expect(formatSkillsAnswer(["Python", "Go"])).toBe("Python, Go");
  });

  it("detects technology field labels", () => {
    expect(isTechnologyFieldLabel("Technologies Known")).toBe(true);
    expect(isTechnologyFieldLabel("Technical Skills")).toBe(true);
    expect(isTechnologyFieldLabel("Nationality")).toBe(false);
  });
});

describe("suggestAnswerFromProfile technologies", () => {
  it("fills Technologies Known from canonical latex", () => {
    const profile: FullProfile = {
      studentId: "x",
      platform: {},
      platformSyncedAt: null,
      manual: {},
      canonicalLatex: sample,
      canonicalLatexUpdatedAt: null,
      onboarding: {},
    };
    const value = suggestAnswerFromProfile("Technologies Known", profile);
    expect(value).toContain("Python");
    expect(value).toContain("React");
  });
});
