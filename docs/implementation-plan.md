# PESU Placement Automation — Implementation Plan

Status: in build. Design is frozen; changes are recorded in both docs.
Companion to: [`source-of-truth.md`](./source-of-truth.md).

If a requirement in this plan disagrees with the source of truth, update the source of truth first, then this plan.

This plan is the build order, not the product definition. It tells you what to implement, in what sequence, how to know a slice is done, and which validations unblock the next slice. It does not authorize writing production code until you explicitly start implementation.

---

## 1. Goal of the build

Ship a personal placement automation that:

1. Polls the PESU eligibility catalog every 5 minutes.
2. Alerts eligible drives on Telegram and mirrors them to Notion.
3. Reminds once when a New drive has under 6 hours left.
4. Verifies “I applied” against the platform before marking Applied.
5. On Prepare, starts a Cursor cloud agent that returns a tailored LaTeX resume and answers.
6. Later classifies recruitment mail and updates the same board.

Version 1 ends at a reviewed draft. No placement submission, resume upload, WhatsApp, WebSocket, or Gemini API.

---

## 2. How to use this plan

| Rule | Meaning |
|---|---|
| One vertical slice at a time | Prefer a thin path that works end to end over building every library first |
| Gate before advancing | Do not start the next milestone until the previous exit criteria pass |
| Deterministic first | No Cursor webhook until a drive can be stored and messaged without a model |
| Secrets never in the repo | Password, tokens, and webhook secrets live only in host env vars |
| Update both docs | Behavior changes update `source-of-truth.md`. Schedule and task changes update this file |

Suggested build unit: one milestone = one mergeable slice with a written acceptance check.

---

## 3. Recommended stack (implementation defaults)

These are defaults for speed on the free tiers already chosen. Swap only if a hard constraint appears.

| Layer | Default | Why |
|---|---|---|
| Runtime | Node.js (LTS) or Python 3.11+ | Either is fine; pick one and stay consistent |
| HTTP server | FastAPI / Express / Hono | Single process that exposes `/cron/poll`, Telegram webhook, and private callbacks |
| DB client | Supabase JS or Python client with service role | Server-only access |
| PDF text | `pdfminer.six` or `pdf-parse` | Extract once per URL version |
| Telegram | Official Bot API, webhook preferred over long polling on Render | Fits always-on process kept awake by cron |
| Notion | Official Notion API | One database, create/update by stored page id |
| Scheduler | cron-job.org, EasyCron, or GitHub Actions schedule calling the private URL | Must be inbound HTTP every 5 minutes |
| Host | Render free web service | One service only |
| Drafter | Cursor Automation, webhook trigger | Draft-only |

Do not spend design time debating frameworks. The architecture does not depend on Node vs Python.

**Chosen at M0:** Node.js 24 LTS and TypeScript, Fastify (its logger redacts credential fields), zod for environment checks, Vitest for tests. The Supabase JS client arrives in M1. TypeScript source lives in `app/`; `dist/` is build output and is not committed.

---

## 4. Repository layout (proposed)

Create this when implementation starts. Until then it is a target shape.

```
pesu/
├── docs/
│   ├── source-of-truth.md
│   └── implementation-plan.md
├── routes.json                    # API evidence, not runtime config
├── app/                           # watcher service
│   ├── main                       # HTTP entry
│   ├── config                     # env loading
│   ├── placement/                 # PESU API client
│   ├── poll/                      # catalog diff, reminders, deadlines
│   ├── auth/                      # session renewal, OTP branch
│   ├── telegram/                  # bot handlers
│   ├── notion/                    # board sync
│   ├── gmail/                     # OTP + later stage mail
│   ├── draft/                     # Cursor webhook + delivery
│   └── pdf/                       # download + extract (+ optional compile)
├── supabase/
│   └── migrations/                # SQL schema
├── cursor-automation/             # prompt / instructions for the drafter
│   └── DRAFTER.md
├── resume/
│   └── canonical.tex              # not committed if it contains private data; prefer secret/storage
└── tests/
    ├── fixtures/                  # redacted list/detail JSON
    └── ...
```

Private data (password, tokens, real resume with contact details) never commits. Redacted API fixtures do. The GitHub repository is public, so a fixture is redacted before it is committed, and unredacted captures stay in the gitignored `.private/` directory.

---

## 5. Milestone map

```
M0 Foundations
    → M1 Placement client + login
        → M2 Catalog poll + Supabase
            → M3 Telegram alerts
                → M4 Notion sync
                    → M5 Session renewal (OTP)
                        → M6 Apply verify + reminder + deadline
                            → M7 Deploy + cron
                                → M8 Onboarding profile + resume
                                    → M9 Cursor drafter
                                        → M10 Draft delivery + compile
                                            → M11 Gmail stages
                                                → M12 Calendar
                                                    → M13 Portable kit (optional)
```

Phases from the source of truth map as:

| Source phase | Milestones |
|---|---|
| Phase 1 Watcher | M0–M8 |
| Phase 2 Drafter | M9–M10 |
| Phase 3 Mail and calendar | M11–M12 |
| Phase 4 Portable | M13 |

---

## 6. Milestones

### M0 — Foundations

**Goal.** Accounts, secrets, empty service that can deploy and be woken.

**Work**

1. Create Supabase free project in `us-east-1` through the Supabase MCP. Revoke anon and authenticated access in `public`, including default privileges for later tables. Enable RLS on every table. Service role only.
2. Create Render free web service `pesu-placement-watcher` (one only) in Virginia through the Render MCP. Confirm no second free web service exists in the workspace. The service builds the `deploy` branch; `main` is not pushed until the owner asks.
3. Telegram bot: moved to M3, where the token is first used.
4. Create the Notion database through the Notion MCP with the properties from the source of truth (no event id, no eligibility column), plus a Board view grouped by Status. Status is a Notion status property: New is to-do; Applied, Assessment and Interview are in progress; Accepted, Rejected and Not Applied are complete. Type, Location, Stipend, CTC and Rounds are text until live drives show their shapes. The internal integration token and sharing the database with it need the owner, because no MCP can mint that token; both move to M4.
5. Google Cloud OAuth client: moved to M5, where the OTP fallback first reads mail.
6. Scaffold the HTTP service with:
   - `GET /health`
   - `POST /cron/poll` (requires `Authorization: Bearer <CRON_SHARED_SECRET>`, returns 401 otherwise, checked before the body is read)
   - config loaded only from environment; boot fails if the cron secret is missing or shorter than 32 characters
7. Document required env vars in a local `.env.example` with empty values and no secrets.

Regions: the placement API resolves to AWS `us-east-1`, so Render runs in Virginia and Supabase in `us-east-1`. A Render service cannot change region after creation.

**Exit criteria**

- Render URL responds to `/health`.
- Unauthenticated `/cron/poll` fails.
- Supabase project exists and is empty or schema-ready, and the anon key cannot read any table.
- No secret is in git. The cron secret is in Render env. The Telegram token is required by M3 and the Notion token by M4.

**Validation**

- Hit `/health` from a phone browser or curl.
- Confirm Render does not sleep if you will start cron later; for M0 a manual hit is enough.

---

### M1 — Placement client and login

**Goal.** Talk to the placement API safely, one call at a time.

**Work**

1. Implement a placement HTTP client with:
   - base URL `https://placements.4gd.ai/backendapi-latest/`
   - bearer attachment for authenticated routes
   - serial execution (queue or mutex): never parallel placement calls
   - explicit handling for 401, 429, 502, timeout
2. Implement `validatestudent(studentID, password)`.
3. Persist token and `studentData` snapshot to Supabase (`secret` / `profile`).
4. Build the eligibility request body from exactly these fields when present: `batch`, `department`, `graduateDegree`, `currentCGPA`, `tenthPercentage`, `twelfthPercentage`, `activeBacklogs`. Numbers stay numbers. Omit missing fields. Do not invent `ugCGPA` or `placementTier`.
5. Implement `getEventsByStudentEligibility`.
6. Implement `getEventDetails(id)`.
7. Implement `getStudent(studentID)`.
8. Implement `checkApplyStatus(studentID, eventID)`.
9. Store redacted fixtures from live Deloitte / Fidelity / NVIDIA captures for tests. Strip tokens, password hashes, and personal fields before git.

**Exit criteria**

- From a local or Render shell, login returns a token and stores it.
- List call returns events with `_id`, `isEligible`, `deadline`, `customFields`, `pdfUrls`.
- Detail call for Fidelity’s `_id` succeeds.
- A deliberate bad token produces a clean 401 path (no crash, no empty-catalog write).

**Live notes (M1)**

- `GET students/{id}` returns the profile at the top level (includes a `password` field — strip before persist).
- `checkApplyStatus` returned `{ success, applied, canApply, message }` for an already-applied Fidelity drive.
- `getEventsByStudentEligibility` currently ignores a bad/missing bearer (still 200 + catalog). Use `getEventDetails` (or getStudent / checkApplyStatus) to exercise the 401 path. Keep attaching the bearer on list calls.

**Do not implement yet**

- Poll loop, Telegram, Notion, OTP mail, Cursor.

---

### M2 — Catalog poll and persistence

**Goal.** Diff the catalog every run and store drives without notifying anyone.

**Work**

1. Schema for `drive`:
   - `id` = top-level `_id`
   - `raw_list`, `raw_detail` JSON
   - `updated_at_platform`
   - `is_eligible`
   - `deadline`
   - `status` (default New for eligible; no card path for ineligible)
   - `reminder_sent`
   - `draft_status`
   - `notion_page_id`
   - `pdf_urls`, `pdf_text`
   - timestamps for first_seen / last_seen
2. Poll algorithm:
   - one list call
   - non-200 or `success != true` → keep previous rows, set alert flag, stop
   - for each event, key by `_id`
   - `isEligible: false` or missing flag: store/update internal row, no user-facing notify path
   - new eligible or changed `updatedAt`: optional detail fetch, PDF download + extract for new/changed URLs only
3. Persist full raw JSON. Extract display fields for queries, but do not discard company-specific shapes.
4. Mark drives past deadline still in New as Not Applied (can wait until M6 if cleaner, but model the field now).

**Exit criteria**

- Two consecutive polls with no catalog change write nothing user-facing and do not re-download PDFs.
- Injecting a fixture with a new `_id` creates a drive row.
- Changing only `updatedAt` in a fixture triggers a refresh path.
- Failed list (simulate 500) leaves prior rows intact.

**Gate**

Do not wire Telegram until this is solid. Silent persistence bugs become spam.

**Live notes (M2)**

- Compare `updated_at_platform` / `deadline` after normalizing to ISO; Postgres `timestamptz` round-trips (`Z` vs `+00:00`) must not force a refresh.
- Unchanged polls touch `last_seen_at` only and do not re-fetch detail or PDFs.

---

### M3 — Telegram alerts

**Goal.** You learn about eligible drives on your phone.

**Work**

1. Telegram webhook endpoint (or long poll if webhook setup is blocked during first deploy). Restrict to your chat id.
2. On new eligible drive: send company, role, deadline in IST, location, stipend/CTC, rounds.
3. Inline buttons: Prepare (disabled behavior until M9: reply “drafting not enabled yet”), I applied (wire in M6).
4. Bind `callback_data` to drive `_id` (short id encoding if Telegram’s 64-byte limit bites).
5. Deduplicate: same drive must not alert again unless deadline / description / eligibility materially changed.
6. First-seen inside 6 hours: include urgency in the first message and set `reminder_sent`.

**Exit criteria**

- Creating a synthetic new eligible row (or waiting for a real drive) produces exactly one Telegram message.
- Ineligible rows produce no message.
- Restarting the service does not re-send alerts for already-seen drives.

**Live notes (M3)**

- `drive.alerted_at` backfilled from `first_seen_at` so the pre-M3 catalog is not re-spammed.
- Webhook: `POST /telegram/webhook` with `X-Telegram-Bot-Api-Secret-Token`; register via `npm run telegram:set-webhook`.
- Prepare / I applied are stubs until M9 / M6.

---

### M4 — Notion sync

**Goal.** Eligible drives appear on the board; later stages are not clobbered.

**Work**

1. Create Notion page when an eligible drive is first notified.
2. Store `notion_page_id` on the drive row.
3. Update properties on material change: deadline, type, location, stipend, CTC, rounds, Updated.
4. Status sync rules:
   - Watcher may set New, Applied, Not Applied.
   - Watcher must not move Assessment / Interview / Accepted / Rejected back to New.
5. Retry failed Notion writes on later polls without creating duplicates (lookup by stored page id; if missing, search by a stable external id stored in an optional hidden property *only if Notion needs it*—prefer Supabase as the join table and avoid showing event id in the UI).

**Exit criteria**

- New eligible drive → one Notion card in New.
- Manual move of a card to Interview survives the next poll.
- Failed Notion token produces a Telegram ops alert once, not a crash loop.

**Live notes (M4)**

- Raw Notion HTTPS client (`Notion-Version: 2022-06-28`); join via `drive.notion_page_id` only (no event-id property).
- Sync after persist: eligible insert/refresh, Not Applied with a page id, and New eligible rows still missing a page id (pre-M4 backfill).
- Status guard: when Supabase is New, retrieve Notion Status first; omit Status if Assessment / Interview / Accepted / Rejected.
- Compensation arrays and `selections[]` on rounds are parsed the same way as Telegram alerts.
- Auth failure → one Telegram ops alert per process lifetime; poll stays `ok`.

---

### M5 — Session renewal and OTP

**Goal.** Survive token expiry without waking you unless OTP is required.

**Work**

1. On authenticated placement 401:
   - call `validatestudent`
   - if token present: store, refresh academic body from `studentData`, Telegram “session renewed”, retry poll once
   - if token absent: enter `awaiting_login_approval`, one Telegram message, stop OTP until approve
2. On Approve:
   - `sendOtp`
   - Gmail search on PESU inbox for messages after the send timestamp matching OTP pattern
   - `verifyOtp`
   - clear waiting state; run poll
3. Chat paste fallback if mail not found within timeout.
4. Ignore OTP mails outside an active renewal.
5. Daily `GET students/{id}` while token works; rebuild eligibility body.

**Exit criteria**

- Simulated 401 with password-only renewal recovers without Approve.
- Simulated no-token path sends exactly one waiting message; second 401 does not spam.
- Approve + inbox OTP (or paste) restores list polling.
- OTP value never appears in logs.

**Dependency**

Google OAuth must work for the PESU account. If consent fails, ship chat-paste-only OTP and continue.

**Live notes (M5)**

- `secret` columns: `login_wait_state`, `login_wait_notified_at`, `otp_sent_at`, `otp_paste_prompted_at`.
- Password renew on list/detail/`getStudent` 401 or missing bearer; full poll retries once.
- OTP branch after Approve: `sendOtp` → Gmail when `GOOGLE_*` PESU is set, else Telegram paste; `verifyOtp` source stored as `verifyOtp`.
- Daily `getStudent` when `platform_synced_at` is older than 24h.
- Shipped paste-first when PESU Gmail OAuth is unset.

---

### M6 — Apply verify, reminder, deadline

**Goal.** Close the loop on applications without trusting chat alone.

**Work**

1. I applied handler:
   - resolve drive from button, or sole New drive, or ask
   - `checkApplyStatus`
   - `applied: true` → Applied in Supabase + Notion
   - `applied: false` → stay New, explain
   - failure → stay New, explain, no tight retry loop
2. Daily pass: for each New drive, one bulk-friendly strategy—prefer `checkApplyStatus` per New drive once a day, or `getAppliedEvents` if proven reliable. Stay under call budget.
3. Reminder: once when `now < deadline` and remaining < 6h and status New and not `reminder_sent`.
4. Deadline pass: after deadline, New → Not Applied.

**Exit criteria**

- Saying I applied before applying in the app does not move the card.
- After applying in the app, I applied moves the card to Applied.
- A New drive with a deadline in 5 hours gets one reminder and no spam every 5 minutes.
- After deadline, status becomes Not Applied and reminders stop.

**Live notes (M6)**

- `drive` columns: `applied_at`, `last_apply_check_at`.
- `verifyApplied` only moves New → Applied on `checkApplyStatus` `applied: true`; false/fail stay New.
- Telegram: `a:<id>` callback, free-text `/^\s*i\s*applied\s*[.!?]?\s*$/i` (0 / 1 / ≤8 ask-which / >8 tip).
- Poll: under-6h reminder once (`reminder_sent`), then daily apply pass (stale ≥24h), stop early on `rateLimited` / `unavailable`.
- Deadline → Not Applied already in M2 diff; reminders skip past-deadline and non-New.
- Strategy: per-drive `checkApplyStatus` only — no `getAppliedEvents` in M6.

---

### M7 — Deploy hardening and cron

**Goal.** Laptop-off operation for the watcher.

**Work**

1. Deploy watcher to Render with all secrets.
2. Configure external cron `POST /cron/poll` every 5 minutes with shared secret header.
3. Confirm the free instance stays awake (hours consumed, no 15-minute sleep).
4. Confirm only one Render free web service exists in the workspace.
5. Add minimal ops Telegram messages: poll failure, Notion failure, 429 backoff.
6. Structured logs without secrets, tokens, OTP, or password.

**Exit criteria**

- Leave the laptop off for several hours. A new or fixture-injected drive still alerts.
- Render instance hours trend toward ~24/day, not sleep/wake spikes.
- Cron secret rejection works from an unauthenticated caller.

**Definition of “watcher MVP done”**

M0–M7 green means you have a usable catalog + alert + apply-verify system without drafting.

---

### M8 — Onboarding: profile and canonical resume

**Goal.** Facts the drafter is allowed to use.

**Work**

1. Telegram (or one-time admin) flow to capture manual fields: JEE, coding platform, URL, rating, contests, certifications, awards, project links.
2. Store platform vs manual sections separately.
3. Accept canonical LaTeX (upload or paste path). Prefer storing in Supabase Storage or as text in `profile`, not on Render disk.
4. Optional: GitHub repo URL → summary for your approval before it becomes a fact.
5. Answer bank table: label → value, reusable flag, approved flag.
6. Pre-seed answers that are deterministic from profile (name parts, email, coding fields) without sending phone/DOB unless a question asks.

**Exit criteria**

- Profile can be fully read by the future draft payload builder.
- Canonical LaTeX round-trips after a Render restart.
- Unapproved GitHub summary is not in the draft payload.

---

### M9 — Cursor drafter

**Goal.** Prepare starts a cloud agent; no placement secrets leave the watcher.

**Work**

1. Create Cursor Automation: webhook trigger, draft-only instructions (`cursor-automation/DRAFTER.md` content from source of truth §10).
2. Watcher `POST` webhook with: drive text, PDF text, `customFields`, canonical resume, approved answers, drive id. Explicitly exclude password and bearer token.
3. Set drive `draft_status = pending`. Telegram “preparing.”
4. Idempotency: second Prepare while pending is ignored.
5. Delivery path A (preferred): agent writes to Supabase `draft` row via a short-lived approach you can support (service path or signed upload URL). Path B: agent calls private `POST /draft/callback` on Render with shared secret.
6. Validate at least one path works before promising Telegram delivery.

**Exit criteria**

- Prepare on a real drive starts exactly one Cursor run.
- Payload inspection (logged keys only, not values of secrets) shows no auth header or password fields.
- Draft row becomes `ready` with LaTeX and answers.

**Hard gate**

If neither Supabase write nor Render callback works from the cloud agent, stop and redesign delivery before building PDF compile. Do not leave drafts stranded inside Cursor.

---

### M10 — Draft delivery and optional PDF compile

**Goal.** You receive usable answers and a resume in Telegram.

**Work**

1. Poll or callback detects `draft_status = ready`.
2. Send answers to Telegram in a readable list.
3. Send LaTeX as a file.
4. Attempt PDF compile on Render in a temp directory (ephemeral is fine). If image size / build time fails, skip compile and document it.
5. Before starting the agent: if required `customFields` lack approved answers, ask in Telegram first, store answers, then start agent.
6. Dropdown answers must be validated against `options`.
7. On agent failure: `draft_status = failed`, clear pending, allow retry.

**Exit criteria**

- End-to-end: alert → Prepare → answers + LaTeX in Telegram within one Cursor run.
- Required missing field is asked before the agent invents it.
- Failed run allows a second Prepare.

**Definition of “version 1 complete”**

M0–M10 green means the product outcome in source of truth §2.2 items 1–5 (item 6 is mail).

---

### M11 — Gmail recruitment stages

**Goal.** Board tracks Assessment / Interview / Rejected / Accepted from mail.

**Work**

1. Gmail history sync for PESU and personal accounts. Persist `historyId` / processed message ids.
2. Classifier (start rules + light model only if rules fail): shortlist presence/absence, assessment, interview, rejection, offer, reschedule, cancel.
3. Match to drive by company + role; ask on ambiguity.
4. Apply shortlist rules from source of truth §5.6 exactly. Silence ≠ rejection.
5. Notify Telegram on confirmed stage change; update Notion without regressing stages incorrectly.
6. Deduplicate message ids; allow genuine thread updates.

**Exit criteria**

- A real shortlist mail that includes your name moves the matched card and notifies once.
- A group shortlist without your name does not auto-reject unless completeness rules pass (default: ask / leave unresolved).
- Reprocessing the same message does not double-notify.

---

### M12 — Google Calendar

**Goal.** Assessments and interviews appear on the calendar.

**Work**

1. Before coding times: manually compare one drive’s `subEvents` (`eventDate` + `startTime`) to what the app UI shows. Record the rule in the source of truth.
2. Prefer times from recruitment mail when present.
3. Create/update/cancel calendar events keyed by drive id + round.
4. Do not create events from application `deadline`.

**Exit criteria**

- One interview invite produces one calendar event.
- Reschedule updates the same event.
- Cancel removes or cancels it.

---

### M13 — Portable kit (optional)

**Goal.** Someone else (or you in Claude Code) can run prepare/check without your Render bot.

**Work**

1. Small CLI: login, list, detail, check-apply-status, using env secrets.
2. Command docs: `/check`, `/prepare`, `/applied` style instructions for agent runners.
3. File-based profile/resume layout inspired by ai-job-search’s structure, not a copy of their prompts.
4. Explicit MIT/license review before publishing anything derived.
5. Do not publish credentials, `routes.json` with secrets, or personal fixtures.

**Exit criteria**

- Fresh clone + env vars can list eligible drives.
- An agent runner can produce a draft from CLI output without the Telegram bot.

---

## 7. Cross-cutting work (every milestone)

| Concern | Standard |
|---|---|
| Secrets | Env only. Log field names, never values for password/token/OTP. |
| Idempotency | Alerts, Notion pages, reminders, Cursor runs keyed by drive id + state flags. |
| Time | Store UTC. Display IST. Reminder math in a single timezone helper. |
| Rate limits | Serial placement calls. Backoff on 429/502. Never speed up after a limit. |
| Empty catalog | Only trust empty when HTTP 200 and `success: true`. |
| Tests | Fixture-based unit tests for diff, reminder, apply-status branching. One integration smoke against the live API when you choose (manual). |
| Docs | Update source of truth when behavior changes. |

---

## 8. Environment variables checklist

| Variable | Needed by |
|---|---|
| `HOST`, `PORT`, `LOG_LEVEL` | Optional. Default `0.0.0.0`, `10000`, `info`. Render sets `PORT` |
| `PLACEMENT_STUDENT_ID` | M1 |
| `PLACEMENT_PASSWORD` | M1 |
| `SUPABASE_URL` | M0 (project), M1 (first use) |
| `SUPABASE_SERVICE_ROLE_KEY` | M1. A legacy `service_role` JWT or an `sb_secret_` key. The Supabase MCP cannot reveal it, so the owner pastes it once |
| `TELEGRAM_BOT_TOKEN` | M3 |
| `TELEGRAM_ALLOWED_CHAT_ID` | M3 |
| `CRON_SHARED_SECRET` | M0 / M7 |
| `NOTION_TOKEN` | M4. Internal integration secret created by the owner |
| `NOTION_DATABASE_ID` | M4. Set at M0, when the database is created |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN_PESU` | M5, M11 |
| `GOOGLE_REFRESH_TOKEN_PERSONAL` | M11 |
| `CURSOR_WEBHOOK_URL` | M9 |
| `CURSOR_WEBHOOK_SECRET` | M9 |
| `DRAFT_CALLBACK_SECRET` | M9 |

---

## 9. Test plan by milestone

| Milestone | Automated | Manual |
|---|---|---|
| M1 | Parse fixtures; body builder omits missing fields | Live login + list |
| M2 | Diff cases: new / unchanged / updatedAt / ineligible / list failure | Two live polls |
| M3 | Dedup logic | Receive one alert |
| M4 | Status transition guard | Card created; later stage not reverted |
| M5 | State machine for approval / OTP timeout | Force logout week or revoke token |
| M6 | Reminder once; apply true/false/fail | Apply in app, then button |
| M7 | — | Laptop off for half a day |
| M9–M10 | Payload redaction unit test | Full Prepare on Fidelity-like drive |
| M11 | Message-id dedup | One real shortlist |
| M12 | — | One invite vs app UI time check |

---

## 10. Risks during implementation

| Risk | Mitigation during build |
|---|---|
| Cursor agent cannot write results out | Prove delivery in M9 before M10 polish |
| OTP JSON differs from “no token” | Capture first OTP-required response; adjust M5 condition |
| TeX too large for Render | Ship LaTeX-only in M10; compile later or elsewhere |
| Placement 429 | Serial client + backoff; reduce daily apply checks first |
| Notion duplicate cards | Always join via Supabase `notion_page_id` |
| Telegram `callback_data` size | Hash or short map table drive_id ↔ button token |
| Free Render hours exhausted | Monitor; never add a second free web service |
| Accidental `apply` call | Do not implement apply client method at all in v1 |
| Secrets in Cursor payload | Explicit allowlist serializer + unit test |

---

## 11. Suggested calendar (personal pace)

Assumes evenings/weekends. Adjust freely.

| Window | Focus |
|---|---|
| Days 1–2 | M0–M1 |
| Days 3–4 | M2–M3 |
| Days 5–6 | M4–M5 |
| Day 7 | M6–M7 → watcher MVP |
| Days 8–9 | M8 |
| Days 10–12 | M9–M10 → version 1 |
| Later | M11–M12 |
| Optional | M13 |

Watcher MVP (M7) is the first useful daily product. Version 1 (M10) is the first complete product per the PRD.

---

## 12. Definition of done

### Watcher MVP (ship gate A)

- [ ] Cron every 5 minutes on Render
- [ ] Eligible drives → Telegram + Notion
- [ ] Ineligible drives silent
- [ ] Session renewal works (password and OTP branch)
- [ ] I applied verified by platform
- [ ] One 6-hour reminder
- [ ] Deadline → Not Applied
- [ ] No placement write APIs implemented

### Version 1 (ship gate B)

- [ ] All of gate A
- [ ] Onboarding profile + canonical LaTeX
- [ ] Prepare → Cursor → answers + LaTeX in Telegram
- [ ] Required question gaps asked first
- [ ] Password/token never in Cursor payload
- [ ] Source of truth still accurate

### Tracking complete (ship gate C)

- [ ] All of gate B
- [ ] Gmail stage updates with shortlist rules
- [ ] Calendar events for interviews/assessments after time-format validation

---

## 13. First action when you authorize implementation

1. Confirm gate order: build Watcher MVP before Drafter.
2. Pick runtime (Node or Python) in one sentence.
3. Start M0: Supabase + Render + Telegram bot + Notion database + env skeleton.
4. Do not create the Cursor automation until M9.

Until you say to start building, this plan remains documentation only.
