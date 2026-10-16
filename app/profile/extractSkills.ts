/**
 * Pull skill tokens from a canonical LaTeX resume's Skills / Technical Skills section.
 * Deterministic — no LLM. Best-effort against common resume templates.
 */
export function extractSkillsFromLatex(latex: string): string[] {
  if (!latex.trim()) {
    return [];
  }

  const sectionMatch = /\\section\*?\{[^}]*(?:Technical\s+Skills|Skills)[^}]*\}([\s\S]*?)(?=\\section|\s*$)/i.exec(
    latex,
  );
  const body = sectionMatch?.[1] ?? latex;

  const fromBoldLines: string[] = [];
  // Common resume form: \textbf{Languages:} Python, Go
  const boldRe = /\\textbf\{([^}]*):\}\s*([^\n\\]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = boldRe.exec(body)) !== null) {
    fromBoldLines.push(...splitSkillList(m[2] ?? ""));
  }

  const source = fromBoldLines.length > 0 ? fromBoldLines.join(", ") : stripLatex(body);
  const skills = splitSkillList(source);
  return dedupeSkills(skills);
}

function stripLatex(input: string): string {
  return input
    .replace(/\\begin\{[^}]+\}/g, " ")
    .replace(/\\end\{[^}]+\}/g, " ")
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?(\{[^}]*\})?/g, " ")
    .replace(/[{}%~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSkillList(text: string): string[] {
  return text
    .split(/,|;|\||•|·|\n/)
    .map((s) =>
      s
        .replace(/\\&/g, "&")
        .replace(/\\textbf\{([^}]*)\}/gi, "$1")
        .replace(/[{}]/g, "")
        .trim(),
    )
    .filter((s) => s.length >= 1 && s.length <= 60)
    .filter((s) => !/^(languages?|frontend|backend|tools?|frameworks?|databases?|cloud|ai|ml|testing)$/i.test(s));
}

function dedupeSkills(skills: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const skill of skills) {
    const key = skill.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(skill);
  }
  return out;
}

export function formatSkillsAnswer(skills: string[], max = 40): string {
  if (skills.length === 0) {
    return "";
  }
  return skills.slice(0, max).join(", ");
}

export function isTechnologyFieldLabel(label: string): boolean {
  const n = label.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    /\btechnolog(?:y|ies)\b/.test(n) ||
    /\btech stack\b/.test(n) ||
    /\btechnical skills?\b/.test(n) ||
    /\bskills? known\b/.test(n) ||
    /\btools? (known|proficien)/.test(n) ||
    n === "skills" ||
    n === "technical skill" ||
    n === "technical skills"
  );
}
