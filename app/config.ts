import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CRON_SHARED_SECRET: z.string().min(32),
  RENDER_GIT_COMMIT: z.string().optional(),
  // Optional until M2 makes them required for the poll. /health still boots without them.
  PLACEMENT_STUDENT_ID: z.string().min(1).optional(),
  PLACEMENT_PASSWORD: z.string().min(1).optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
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
