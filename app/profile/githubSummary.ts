const MAX_README_CHARS = 4000;
const SUMMARY_CHARS = 400;

/**
 * Fetch a short public summary for a GitHub repo URL (no LLM).
 * Accepts https://github.com/owner/repo forms.
 */
export async function summarizeGithubRepo(
  url: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<{ ok: true; summary: string } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
    return { ok: false, reason: "not_github" };
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return { ok: false, reason: "not_repo" };
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, "");
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`;

  try {
    const res = await fetchImpl(rawUrl, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) {
      return {
        ok: true,
        summary: `GitHub ${owner}/${repo} (README not readable; confirm this is your project).`,
      };
    }
    const text = (await res.text()).slice(0, MAX_README_CHARS);
    const cleaned = text
      .replace(/^#+\s*/gm, "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const summary =
      cleaned.slice(0, SUMMARY_CHARS) + (cleaned.length > SUMMARY_CHARS ? "…" : "");
    return {
      ok: true,
      summary: summary || `GitHub ${owner}/${repo}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network";
    return { ok: false, reason };
  }
}
