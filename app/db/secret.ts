import type { DbClient } from "./client.ts";

export type TokenSource = "validatestudent" | "verifyOtp";

export type StoredSecret = {
  bearerToken: string | null;
  tokenObtainedAt: string | null;
  tokenSource: TokenSource | null;
};

export async function upsertBearerToken(
  db: DbClient,
  token: string,
  source: TokenSource,
  obtainedAt: Date = new Date(),
): Promise<void> {
  const { error } = await db.from("secret").upsert(
    {
      id: 1,
      bearer_token: token,
      token_obtained_at: obtainedAt.toISOString(),
      token_source: source,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) {
    throw new Error(`secret upsert failed: ${error.message}`);
  }
}

export async function loadBearerToken(db: DbClient): Promise<StoredSecret> {
  const { data, error } = await db
    .from("secret")
    .select("bearer_token, token_obtained_at, token_source")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    throw new Error(`secret load failed: ${error.message}`);
  }
  return {
    bearerToken: data?.bearer_token ?? null,
    tokenObtainedAt: data?.token_obtained_at ?? null,
    tokenSource: (data?.token_source as TokenSource | null) ?? null,
  };
}

export async function clearBearerToken(db: DbClient): Promise<void> {
  const { error } = await db.from("secret").upsert(
    {
      id: 1,
      bearer_token: null,
      token_obtained_at: null,
      token_source: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) {
    throw new Error(`secret clear failed: ${error.message}`);
  }
}
