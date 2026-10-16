#!/usr/bin/env node
/**
 * Render Cron Job entry: POST /cron/poll with shared secret.
 * Env: WATCHER_URL, CRON_SHARED_SECRET
 */
const urlBase = (process.env.WATCHER_URL ?? "").replace(/\/$/, "");
const secret = process.env.CRON_SHARED_SECRET ?? "";
if (!urlBase || secret.length < 32) {
  console.error("WATCHER_URL and CRON_SHARED_SECRET (>=32) required");
  process.exit(1);
}

const res = await fetch(`${urlBase}/cron/poll`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  },
  body: "{}",
});

const text = await res.text();
console.log(`status=${res.status} body=${text.slice(0, 500)}`);
if (!res.ok) {
  process.exit(1);
}
