export type ManualProject = {
  name: string;
  url?: string;
  blurb?: string;
};

export type ManualCoding = {
  platform?: string;
  url?: string;
  rating?: string;
  contests?: string;
};

export type ManualJee = {
  percentile?: string;
  rank?: string;
};

/** Facts typed by the student. Platform sync never writes this. */
export type ManualProfile = {
  jee?: ManualJee;
  coding?: ManualCoding;
  certifications?: string[];
  awards?: string[];
  projects?: ManualProject[];
};

export type GithubPending = {
  url: string;
  summary: string;
};

export type OnboardingState = {
  step?: string;
  expect?: string;
  mode?: "fresh" | "redo" | "latex" | "github";
  draft_manual?: ManualProfile;
  draft_latex?: string;
  github_pending?: GithubPending[];
  github_queue?: string[];
};

export function emptyManual(): ManualProfile {
  return {};
}

export function asManual(value: unknown): ManualProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const out: ManualProfile = {};

  if (raw.jee && typeof raw.jee === "object" && !Array.isArray(raw.jee)) {
    const jee = raw.jee as Record<string, unknown>;
    out.jee = {
      percentile: typeof jee.percentile === "string" ? jee.percentile : undefined,
      rank: typeof jee.rank === "string" ? jee.rank : undefined,
    };
  }
  if (raw.coding && typeof raw.coding === "object" && !Array.isArray(raw.coding)) {
    const coding = raw.coding as Record<string, unknown>;
    out.coding = {
      platform: typeof coding.platform === "string" ? coding.platform : undefined,
      url: typeof coding.url === "string" ? coding.url : undefined,
      rating: typeof coding.rating === "string" ? coding.rating : undefined,
      contests: typeof coding.contests === "string" ? coding.contests : undefined,
    };
  }
  if (Array.isArray(raw.certifications)) {
    out.certifications = raw.certifications.filter((x): x is string => typeof x === "string");
  }
  if (Array.isArray(raw.awards)) {
    out.awards = raw.awards.filter((x): x is string => typeof x === "string");
  }
  if (Array.isArray(raw.projects)) {
    out.projects = raw.projects
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && !Array.isArray(p))
      .map((p) => ({
        name: typeof p.name === "string" ? p.name : "Project",
        url: typeof p.url === "string" ? p.url : undefined,
        blurb: typeof p.blurb === "string" ? p.blurb : undefined,
      }));
  }
  return out;
}

export function asOnboarding(value: unknown): OnboardingState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  return {
    step: typeof raw.step === "string" ? raw.step : undefined,
    expect: typeof raw.expect === "string" ? raw.expect : undefined,
    mode:
      raw.mode === "fresh" || raw.mode === "redo" || raw.mode === "latex" || raw.mode === "github"
        ? raw.mode
        : undefined,
    draft_manual: raw.draft_manual !== undefined ? asManual(raw.draft_manual) : undefined,
    draft_latex: typeof raw.draft_latex === "string" ? raw.draft_latex : undefined,
    github_pending: Array.isArray(raw.github_pending)
      ? raw.github_pending
          .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
          .map((g) => ({
            url: typeof g.url === "string" ? g.url : "",
            summary: typeof g.summary === "string" ? g.summary : "",
          }))
          .filter((g) => g.url)
      : undefined,
    github_queue: Array.isArray(raw.github_queue)
      ? raw.github_queue.filter((u): u is string => typeof u === "string")
      : undefined,
  };
}

export function deepMergeManual(base: ManualProfile, patch: ManualProfile): ManualProfile {
  return {
    jee: patch.jee ? { ...base.jee, ...patch.jee } : base.jee,
    coding: patch.coding ? { ...base.coding, ...patch.coding } : base.coding,
    certifications: patch.certifications !== undefined ? patch.certifications : base.certifications,
    awards: patch.awards !== undefined ? patch.awards : base.awards,
    projects: patch.projects !== undefined ? patch.projects : base.projects,
  };
}
