/**
 * Live smoke: clear bearer, renew via validatestudent, confirm token restored.
 * Does not print tokens or passwords.
 */
import { loadConfig, requirePlacementCredentials, requireSupabase, hasTelegram, requireTelegram } from "../app/config.ts";
import { renewFromUnauthorized } from "../app/auth/renew.ts";
import { createDbClient } from "../app/db/client.ts";
import { clearBearerToken, loadAuthState, loadBearerToken, upsertBearerToken } from "../app/db/secret.ts";
import { PlacementClient } from "../app/placement/client.ts";
import { TelegramClient } from "../app/telegram/client.ts";

const config = loadConfig();
const supabase = requireSupabase(config);
const creds = requirePlacementCredentials(config);
const db = createDbClient(supabase.url, supabase.serviceRoleKey);
const placement = new PlacementClient({
  onUnauthorized: async () => {
    await clearBearerToken(db);
  },
});

const before = await loadBearerToken(db);
console.log(JSON.stringify({ hadToken: Boolean(before.bearerToken), source: before.tokenSource }));

await clearBearerToken(db);
const cleared = await loadBearerToken(db);
console.log(JSON.stringify({ cleared: !cleared.bearerToken }));

let telegram: TelegramClient | undefined;
if (hasTelegram(config)) {
  const tg = requireTelegram(config);
  telegram = new TelegramClient({ botToken: tg.botToken });
}

const renew = await renewFromUnauthorized({ config, db, placement, telegram });
const after = await loadAuthState(db);
console.log(
  JSON.stringify({
    renew: renew.kind,
    hasToken: Boolean(after.bearerToken),
    tokenSource: after.tokenSource,
    waitState: after.loginWaitState,
    tokenLen: after.bearerToken?.length ?? 0,
  }),
);

// If renew failed oddly, try one direct login restore so we do not leave the watcher logged out.
if (renew.kind !== "renewed" && !after.bearerToken) {
  const login = await placement.validateStudent(creds.studentId, creds.password);
  if (login.kind === "ok") {
    await upsertBearerToken(db, login.data.token, "validatestudent");
    console.log(JSON.stringify({ restoredManually: true }));
  } else {
    console.log(JSON.stringify({ restoredManually: false, loginKind: login.kind }));
  }
}
