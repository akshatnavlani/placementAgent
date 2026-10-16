import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { placementSchemas } from "../app/placement/client.ts";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function load(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixturesDir, name), "utf8")) as unknown;
}

describe("fixtures parse with client schemas", () => {
  it("login", async () => {
    const parsed = placementSchemas.loginResponseSchema.safeParse(await load("login.json"));
    expect(parsed.success).toBe(true);
  });

  it("list", async () => {
    const parsed = placementSchemas.listResponseSchema.safeParse(await load("list.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.events.length).toBeGreaterThan(0);
      for (const event of parsed.data.events) {
        expect(event._id).toBeTruthy();
      }
    }
  });

  it("detail", async () => {
    const parsed = placementSchemas.eventFieldsSchema.safeParse(await load("detail-fidelity.json"));
    expect(parsed.success).toBe(true);
  });

  it("checkApplyStatus", async () => {
    const parsed = placementSchemas.checkApplyStatusSchema.safeParse(await load("checkApplyStatus.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.applied ?? parsed.data.hasApplied).toBeTypeOf("boolean");
    }
  });

  it("getStudent has studentID", async () => {
    const body = (await load("getStudent.json")) as Record<string, unknown>;
    expect(typeof body.studentID).toBe("string");
    expect(body).not.toHaveProperty("password");
  });
});
