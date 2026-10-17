import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CRON_SHARED_SECRET: z.string().min(32),
  RENDER_GIT_COMMIT: z.string().optional(),
  // Optional until used. /health still boots without them.
  PLACEMENT_STUDENT_ID: z.string().min(1).optional(),
  PLACEMENT_PASSWORD: z.string().min(1).optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_ALLOWED_CHAT_ID: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(32).optional(),
  NOTION_TOKEN: z.string().min(1).optional(),
  NOTION_DATABASE_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REFRESH_TOKEN_PESU: z.string().min(1).optional(),
  GOOGLE_REFRESH_TOKEN_PERSONAL: z.string().min(1).optional(),
  CURSOR_WEBHOOK_URL: z.string().url().optional(),
  CURSOR_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Claude Code routine API fire URL (…/routines/trig_…/fire). */
  CLAUDE_CODE_ROUTINE_FIRE_URL: z.string().url().optional(),
  /** Per-routine bearer token (sk-ant-oat01-…). */
  CLAUDE_CODE_ROUTINE_TOKEN: z.string().min(1).optional(),
  DRAFT_CALLBACK_SECRET: z.string().min(32).optional(),
  /** Public base URL of this watcher (e.g. https://pesu-placement-watcher.onrender.com). */
  PUBLIC_BASE_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof envSchema>;

// Blank lines copied from .env.example mean "not set", not "set to empty".
function withoutBlanks(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim() !== "")
      .map(([key, value]) => [key, value.trim()]),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(withoutBlanks(env));
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment. ${problems.join("; ")}`);
  }
  return result.data;
}

function requireVar<K extends keyof Config>(config: Config, key: K): NonNullable<Config[K]> {
  const value = config[key];
  if (value === undefined || value === "") {
    throw new Error(`missing ${String(key)}`);
  }
  return value as NonNullable<Config[K]>;
}

export function requirePlacementCredentials(config: Config): {
  studentId: string;
  password: string;
} {
  return {
    studentId: requireVar(config, "PLACEMENT_STUDENT_ID"),
    password: requireVar(config, "PLACEMENT_PASSWORD"),
  };
}

export function requireSupabase(config: Config): {
  url: string;
  serviceRoleKey: string;
} {
  return {
    url: requireVar(config, "SUPABASE_URL"),
    serviceRoleKey: requireVar(config, "SUPABASE_SERVICE_ROLE_KEY"),
  };
}

export function requireTelegram(config: Config): {
  botToken: string;
  chatId: string;
  webhookSecret: string;
} {
  return {
    botToken: requireVar(config, "TELEGRAM_BOT_TOKEN"),
    chatId: requireVar(config, "TELEGRAM_ALLOWED_CHAT_ID"),
    webhookSecret: requireVar(config, "TELEGRAM_WEBHOOK_SECRET"),
  };
}

export function hasTelegram(config: Config): boolean {
  return Boolean(
    config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_ALLOWED_CHAT_ID && config.TELEGRAM_WEBHOOK_SECRET,
  );
}

export function requireNotion(config: Config): {
  token: string;
  databaseId: string;
} {
  return {
    token: requireVar(config, "NOTION_TOKEN"),
    databaseId: normalizeNotionDatabaseId(requireVar(config, "NOTION_DATABASE_ID")),
  };
}

export function hasNotion(config: Config): boolean {
  return Boolean(config.NOTION_TOKEN && config.NOTION_DATABASE_ID);
}

/** Accept dashed or undashed UUIDs; Notion API accepts either. */
export function normalizeNotionDatabaseId(raw: string): string {
  const hex = raw.replace(/[^a-fA-F0-9]/g, "");
  if (hex.length === 32) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return raw.trim();
}

export function requireGmailPesu(config: Config): {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
} {
  return {
    clientId: requireVar(config, "GOOGLE_CLIENT_ID"),
    clientSecret: requireVar(config, "GOOGLE_CLIENT_SECRET"),
    refreshToken: requireVar(config, "GOOGLE_REFRESH_TOKEN_PESU"),
  };
}

export function hasGmailPesu(config: Config): boolean {
  return Boolean(
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REFRESH_TOKEN_PESU,
  );
}

export function requireGmailPersonal(config: Config): {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
} {
  return {
    clientId: requireVar(config, "GOOGLE_CLIENT_ID"),
    clientSecret: requireVar(config, "GOOGLE_CLIENT_SECRET"),
    refreshToken: requireVar(config, "GOOGLE_REFRESH_TOKEN_PERSONAL"),
  };
}

export function hasGmailPersonal(config: Config): boolean {
  return Boolean(
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REFRESH_TOKEN_PERSONAL,
  );
}

/** Same personal OAuth as Gmail; refresh must include calendar scope after M12 re-mint. */
export function requireCalendarPersonal(config: Config): {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
} {
  return requireGmailPersonal(config);
}

export function hasCalendarPersonal(config: Config): boolean {
  return hasGmailPersonal(config);
}

export function requireDraftCallbackSecret(config: Config): string {
  return requireVar(config, "DRAFT_CALLBACK_SECRET");
}

export type DrafterProvider = "claude_code" | "cursor";

export type DrafterConfig =
  | {
      provider: "claude_code";
      fireUrl: string;
      fireToken: string;
      callbackSecret: string;
      publicBaseUrl: string;
    }
  | {
      provider: "cursor";
      webhookUrl: string;
      webhookSecret: string | undefined;
      callbackSecret: string;
      publicBaseUrl: string;
    };

function hasClaudeCodeDrafter(config: Config): boolean {
  return Boolean(
    config.CLAUDE_CODE_ROUTINE_FIRE_URL &&
      config.CLAUDE_CODE_ROUTINE_TOKEN &&
      config.DRAFT_CALLBACK_SECRET &&
      config.PUBLIC_BASE_URL,
  );
}

export function hasCursorDrafter(config: Config): boolean {
  return Boolean(config.CURSOR_WEBHOOK_URL && config.DRAFT_CALLBACK_SECRET && config.PUBLIC_BASE_URL);
}

/** True when either Claude Code or Cursor drafter env is complete. */
export function hasDrafter(config: Config): boolean {
  return hasClaudeCodeDrafter(config) || hasCursorDrafter(config);
}

/**
 * Prefer Claude Code when both providers are configured (migration default).
 */
export function requireDrafter(config: Config): DrafterConfig {
  const callbackSecret = requireDraftCallbackSecret(config);
  const publicBaseUrl = requireVar(config, "PUBLIC_BASE_URL").replace(/\/$/, "");

  if (hasClaudeCodeDrafter(config)) {
    return {
      provider: "claude_code",
      fireUrl: requireVar(config, "CLAUDE_CODE_ROUTINE_FIRE_URL"),
      fireToken: requireVar(config, "CLAUDE_CODE_ROUTINE_TOKEN"),
      callbackSecret,
      publicBaseUrl,
    };
  }

  return {
    provider: "cursor",
    webhookUrl: requireVar(config, "CURSOR_WEBHOOK_URL"),
    webhookSecret: config.CURSOR_WEBHOOK_SECRET,
    callbackSecret,
    publicBaseUrl,
  };
}

/** @deprecated Prefer requireDrafter; kept for Cursor-only call sites/tests. */
export function requireCursorDrafter(config: Config): {
  webhookUrl: string;
  webhookSecret: string | undefined;
  callbackSecret: string;
  publicBaseUrl: string;
} {
  const drafter = requireDrafter(config);
  if (drafter.provider !== "cursor") {
    throw new Error("Cursor drafter not configured (Claude Code is preferred when both are set)");
  }
  return {
    webhookUrl: drafter.webhookUrl,
    webhookSecret: drafter.webhookSecret,
    callbackSecret: drafter.callbackSecret,
    publicBaseUrl: drafter.publicBaseUrl,
  };
}
