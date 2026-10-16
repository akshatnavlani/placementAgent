import type { Config } from "../config.ts";
import { hasGmailPersonal, hasGmailPesu, requireGmailPersonal, requireGmailPesu } from "../config.ts";
import type { MailAccount } from "../db/mail.ts";
import { GmailClient, type GmailLogger } from "./client.ts";

export type Mailbox = {
  account: MailAccount;
  client: GmailClient;
};

export function listConfiguredMailboxes(
  config: Config,
  options: { fetch?: typeof globalThis.fetch; log?: GmailLogger } = {},
): Mailbox[] {
  const out: Mailbox[] = [];
  if (hasGmailPesu(config)) {
    const creds = requireGmailPesu(config);
    out.push({
      account: "pesu",
      client: new GmailClient({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        refreshToken: creds.refreshToken,
        fetch: options.fetch,
        log: options.log,
      }),
    });
  }
  if (hasGmailPersonal(config)) {
    const creds = requireGmailPersonal(config);
    out.push({
      account: "personal",
      client: new GmailClient({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        refreshToken: creds.refreshToken,
        fetch: options.fetch,
        log: options.log,
      }),
    });
  }
  return out;
}
