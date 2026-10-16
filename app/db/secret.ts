import type { DbClient } from "./client.ts";

export type TokenSource = "validatestudent" | "verifyOtp";

export type LoginWaitState = "awaiting_approval" | "awaiting_otp";

export type StoredSecret = {
  bearerToken: string | null;
  tokenObtainedAt: string | null;
  tokenSource: TokenSource | null;
};

export type AuthState = StoredSecret & {
  loginWaitState: LoginWaitState | null;
  loginWaitNotifiedAt: string | null;
  otpSentAt: string | null;
  otpPastePromptedAt: string | null;
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
  const state = await loadAuthState(db);
  return {
    bearerToken: state.bearerToken,
    tokenObtainedAt: state.tokenObtainedAt,
    tokenSource: state.tokenSource,
  };
}

export async function loadAuthState(db: DbClient): Promise<AuthState> {
  const { data, error } = await db
    .from("secret")
    .select(
      "bearer_token, token_obtained_at, token_source, login_wait_state, login_wait_notified_at, otp_sent_at, otp_paste_prompted_at",
    )
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    throw new Error(`secret load failed: ${error.message}`);
  }
  return {
    bearerToken: (data?.bearer_token as string | null) ?? null,
    tokenObtainedAt: (data?.token_obtained_at as string | null) ?? null,
    tokenSource: (data?.token_source as TokenSource | null) ?? null,
    loginWaitState: (data?.login_wait_state as LoginWaitState | null) ?? null,
    loginWaitNotifiedAt: (data?.login_wait_notified_at as string | null) ?? null,
    otpSentAt: (data?.otp_sent_at as string | null) ?? null,
    otpPastePromptedAt: (data?.otp_paste_prompted_at as string | null) ?? null,
  };
}

export async function clearBearerToken(db: DbClient): Promise<void> {
  const { error } = await db
    .from("secret")
    .update({
      bearer_token: null,
      token_obtained_at: null,
      token_source: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) {
    // Row may not exist yet.
    const upsert = await db.from("secret").upsert(
      {
        id: 1,
        bearer_token: null,
        token_obtained_at: null,
        token_source: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (upsert.error) {
      throw new Error(`secret clear failed: ${upsert.error.message}`);
    }
  }
}

export async function setLoginWait(
  db: DbClient,
  state: LoginWaitState,
  options: { notifiedAt?: Date | null; otpSentAt?: Date | null; pastePromptedAt?: Date | null } = {},
): Promise<void> {
  const patch: Record<string, unknown> = {
    login_wait_state: state,
    updated_at: new Date().toISOString(),
  };
  if (options.notifiedAt !== undefined) {
    patch.login_wait_notified_at = options.notifiedAt ? options.notifiedAt.toISOString() : null;
  }
  if (options.otpSentAt !== undefined) {
    patch.otp_sent_at = options.otpSentAt ? options.otpSentAt.toISOString() : null;
  }
  if (options.pastePromptedAt !== undefined) {
    patch.otp_paste_prompted_at = options.pastePromptedAt
      ? options.pastePromptedAt.toISOString()
      : null;
  }
  const { error } = await db.from("secret").upsert({ id: 1, ...patch }, { onConflict: "id" });
  if (error) {
    throw new Error(`secret setLoginWait failed: ${error.message}`);
  }
}

export async function markOtpSent(db: DbClient, sentAt: Date = new Date()): Promise<void> {
  await setLoginWait(db, "awaiting_otp", {
    otpSentAt: sentAt,
    pastePromptedAt: null,
  });
}

export async function markOtpPastePrompted(db: DbClient, at: Date = new Date()): Promise<void> {
  const { error } = await db
    .from("secret")
    .update({
      otp_paste_prompted_at: at.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) {
    throw new Error(`secret markOtpPastePrompted failed: ${error.message}`);
  }
}

export async function clearLoginWait(db: DbClient): Promise<void> {
  const { error } = await db
    .from("secret")
    .update({
      login_wait_state: null,
      login_wait_notified_at: null,
      otp_sent_at: null,
      otp_paste_prompted_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) {
    throw new Error(`secret clearLoginWait failed: ${error.message}`);
  }
}
