import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const forbidden = [
  "studentevents/apply",
  "studentevents/uploadEventResume",
  "students/uploadResume",
  "studentevents/unapply",
  "tokens/register-token",
  "students/updateStudentInfo",
  "inapp/ws-config",
];

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../app");

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("v1 forbidden placement routes", () => {
  it("do not appear anywhere under app/", async () => {
    const files = await listTsFiles(appRoot);
    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const route of forbidden) {
        if (text.includes(route)) {
          hits.push(`${path.relative(appRoot, file)}: ${route}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
