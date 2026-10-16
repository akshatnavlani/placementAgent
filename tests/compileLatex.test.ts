import { describe, expect, it } from "vitest";
import { compileLatexToPdf } from "../app/draft/compile.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("compileLatexToPdf", () => {
  it("returns pdf on successful runCommand", async () => {
    const workRoot = await mkdtemp(join(tmpdir(), "tex-"));
    const result = await compileLatexToPdf("\\documentclass{article}\\begin{document}Hi\\end{document}", "d1", {
      workRoot,
      tectonicBin: "/tmp/fake-tectonic",
      ensureTectonic: async () => undefined,
      runCommand: async (_bin, _args, cwd) => {
        await writeFile(join(cwd, "resume.pdf"), Buffer.from("%PDF-1.4 fake"));
        return { code: 0, stderr: "" };
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pdf.toString()).toContain("%PDF");
    }
  });

  it("returns reason on tectonic setup failure", async () => {
    const result = await compileLatexToPdf("x", "d1", {
      ensureTectonic: async () => {
        throw new Error("no binary");
      },
    });
    expect(result).toEqual({ ok: false, reason: "no binary" });
  });

  it("maps timeout exit code", async () => {
    const result = await compileLatexToPdf("x", "d1", {
      ensureTectonic: async () => undefined,
      runCommand: async () => ({ code: 124, stderr: "compile timeout" }),
    });
    expect(result).toEqual({ ok: false, reason: "compile timeout" });
  });
});
