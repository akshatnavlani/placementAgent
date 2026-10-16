/**
 * Live placement smoke: login → store → list → detail → getStudent → checkApplyStatus → bad token.
 * Never prints token, password, phone, DOB, or email.
 *
 *   npm run placement:smoke
 */
import { loadConfig, requirePlacementCredentials, requireSupabase } from "../app/config.ts";
import { createDbClient } from "../app/db/client.ts";
import { upsertPlatformProfile } from "../app/db/profile.ts";
import { clearBearerToken, loadBearerToken, upsertBearerToken } from "../app/db/secret.ts";
import { PlacementClient } from "../app/placement/client.ts";
import { buildEligibilityBody } from "../app/placement/eligibilityBody.ts";

function summarizeEvent(event: Record<string, unknown>) {
  return {
    _id: event._id,
    companyName: event.companyName,
    eventName: event.eventName,
    isEligible: event.isEligible,
    deadline: event.deadline,
    hasCustomFields: Array.isArray(event.customFields),
    hasPdfUrls: Array.isArray(event.pdfUrls),
  };
}

const config = loadConfig();
const { studentId, password } = requirePlacementCredentials(config);
const { url, serviceRoleKey } = requireSupabase(config);
const db = createDbClient(url, serviceRoleKey);

const client = new PlacementClient({
  log: {
    info: (obj, msg) => console.log(JSON.stringify({ level: "info", msg, ...obj })),
    warn: (obj, msg) => console.warn(JSON.stringify({ level: "warn", msg, ...obj })),
  },
  onUnauthorized: async () => {
    await clearBearerToken(db);
  },
});

console.log("1. validateStudent…");
const login = await client.validateStudent(studentId, password);
if (login.kind === "noToken") {
  console.log("login: noToken (OTP branch; not handled in M1)");
  process.exit(1);
}
if (login.kind !== "ok") {
  console.log("login failed:", login.kind);
  process.exit(1);
}
console.log("login: ok (token present, profile keys:", Object.keys(login.data.profile).length, ")");

await upsertBearerToken(db, login.data.token, "validatestudent");
const profileStudentId =
  typeof login.data.profile.studentID === "string" ? login.data.profile.studentID : studentId;
await upsertPlatformProfile(db, profileStudentId, login.data.profile);
console.log("2. stored token + platform profile in Supabase");

const { body, omitted } = buildEligibilityBody(login.data.profile);
if (omitted.length > 0) {
  console.log("eligibility omitted fields:", omitted.join(", "));
}

console.log("3. getEventsByStudentEligibility…");
const list = await client.getEventsByStudentEligibility(login.data.token, body);
if (list.kind !== "ok") {
  console.log("list failed:", list.kind);
  process.exit(1);
}
const events = list.data.events;
const eligible = events.filter((e) => e.isEligible === true).length;
const ineligible = events.filter((e) => e.isEligible === false).length;
const unknown = events.length - eligible - ineligible;
console.log(
  `list: total=${events.length} eligible=${eligible} ineligible=${ineligible} unknownEligibility=${unknown}`,
);
for (const event of events) {
  console.log(JSON.stringify(summarizeEvent(event)));
}

const fidelity = events.find((e) => {
  const name = String(e.companyName ?? "").toLowerCase();
  return name.includes("fidelity");
});
const detailTarget = fidelity ?? events[0];
if (!detailTarget) {
  console.log("4. no events in catalog; skipping detail/checkApplyStatus");
} else {
  const which = fidelity ? "Fidelity" : "first catalog drive (Fidelity not present)";
  console.log(`4. getEventDetails for ${which} _id…`);
  const detail = await client.getEventDetails(login.data.token, detailTarget._id);
  if (detail.kind !== "ok") {
    console.log("detail failed:", detail.kind);
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      _id: detail.data._id,
      companyName: detail.data.companyName,
      eventName: detail.data.eventName,
      hasCustomFields: Array.isArray(detail.data.customFields),
      hasPdfUrls: Array.isArray(detail.data.pdfUrls),
    }),
  );

  console.log("5. getStudent…");
  const student = await client.getStudent(login.data.token, studentId);
  if (student.kind !== "ok") {
    console.log("getStudent failed:", student.kind);
    process.exit(1);
  }
  const s = student.data;
  console.log(
    JSON.stringify({
      hasStudentID: typeof s.studentID === "string",
      hasBatch: s.batch !== undefined,
      hasDepartment: typeof s.department === "string",
      // intentionally omit phone, DOB, email, name
    }),
  );

  console.log("6. checkApplyStatus…");
  const status = await client.checkApplyStatus(login.data.token, studentId, detailTarget._id);
  if (status.kind !== "ok") {
    console.log("checkApplyStatus failed:", status.kind);
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      applied: status.data.applied,
      canApply: status.data.canApply,
      hasEligibilityReasons: status.data.eligibilityReasons !== undefined,
    }),
  );
}

console.log("7. detail with fake token (expect unauthorized, stored token untouched)…");
// Live note: getEventsByStudentEligibility currently returns 200 even with a bad/missing
// bearer. getEventDetails / getStudent / checkApplyStatus still 401. Use detail for the 401 path.
// Fake token is not the stored one, so do not attach onUnauthorized.
const probe = new PlacementClient({
  log: {
    info: (obj, msg) => console.log(JSON.stringify({ level: "info", msg, ...obj })),
    warn: (obj, msg) => console.warn(JSON.stringify({ level: "warn", msg, ...obj })),
  },
});
const before = await loadBearerToken(db);
const badId = detailTarget?._id ?? "000000000000000000000000";
const bad = await probe.getEventDetails("definitely-not-a-real-token", badId);
const after = await loadBearerToken(db);
console.log(
  JSON.stringify({
    outcome: bad.kind,
    storedTokenUnchanged: before.bearerToken === after.bearerToken && before.bearerToken !== null,
  }),
);

if (bad.kind !== "unauthorized") {
  console.log("expected unauthorized");
  process.exit(1);
}
if (!before.bearerToken || before.bearerToken !== after.bearerToken) {
  console.log("stored token was altered; failing");
  process.exit(1);
}

console.log("smoke ok");
