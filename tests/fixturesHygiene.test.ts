import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Real PESU SRN shape: PES + campus digit + UG/PG + year + dept + roll. */
const realSrn = /\bPES\d(?:UG|PG)\d{2}[A-Z]{2}\d{3}\b/;
const jwtLike = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const tenDigitPhone = /(?:^|[^0-9])(\d{10})(?:[^0-9]|$)/;
const realEmail = /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

describe("fixture hygiene", () => {
  it("contains no JWT-like tokens, real SRNs, 10-digit phones, or non-example emails", async () => {
    const files = (await readdir(fixturesDir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const text = await readFile(path.join(fixturesDir, file), "utf8");
      if (jwtLike.test(text)) {
        violations.push(`${file}: JWT-like eyJ…`);
      }
      if (realSrn.test(text)) {
        violations.push(`${file}: real-looking SRN`);
      }
      const phone = text.match(tenDigitPhone);
      if (phone) {
        violations.push(`${file}: 10-digit number ${phone[1]}`);
      }
      const email = text.match(realEmail);
      if (email) {
        violations.push(`${file}: email ${email[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
