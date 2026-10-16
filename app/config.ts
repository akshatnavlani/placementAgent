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
