import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Fixed tectonic release used on Linux x86_64 (Render). */
export const TECTONIC_URL =
  "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-gnu.tar.gz";

export const TECTONIC_BIN = "/tmp/tectonic";
export const COMPILE_TIMEOUT_MS = 60_000;

export type CompileResult =
  | { ok: true; pdf: Buffer }
  | { ok: false; reason: string };

export type CompileDeps = {
  fetch?: typeof globalThis.fetch;
  tectonicBin?: string;
  workRoot?: string;
  runCommand?: (
    bin: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<{ code: number; stderr: string }>;
  ensureTectonic?: (bin: string, fetchImpl: typeof fetch) => Promise<void>;
};

export async function defaultRunCommand(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000);
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 124, stderr: stderr || "compile timeout" });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

export async function ensureTectonicBinary(
  binPath: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    const st = await stat(binPath);
    if (st.isFile() && st.size > 0) {
      await chmod(binPath, 0o755);
      return;
    }
  } catch {
    // download below
  }

  const response = await fetchImpl(TECTONIC_URL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    throw new Error(`tectonic download http ${response.status}`);
  }

  const tarPath = `${binPath}.tar.gz`;
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tarPath));

  const extract = await defaultRunCommand(
    "tar",
    ["-xzf", tarPath, "-C", "/tmp"],
    "/tmp",
    60_000,
  );
  if (extract.code !== 0) {
    throw new Error(`tectonic extract failed: ${extract.stderr.slice(0, 200) || "tar error"}`);
  }

  await chmod(binPath, 0o755);
  const st = await stat(binPath);
  if (!st.isFile() || st.size === 0) {
    throw new Error("tectonic binary missing after extract");
  }
}

/**
 * Best-effort LaTeX → PDF via tectonic in /tmp.
 */
export async function compileLatexToPdf(
  latex: string,
  driveId: string,
  deps: CompileDeps = {},
): Promise<CompileResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const bin = deps.tectonicBin ?? TECTONIC_BIN;
  const workRoot = deps.workRoot ?? "/tmp";
  const run = deps.runCommand ?? defaultRunCommand;
  const ensure = deps.ensureTectonic ?? ensureTectonicBinary;

  const safeId = driveId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "drive";
  const dir = join(workRoot, `draft-${safeId}-${Date.now()}`);

  try {
    try {
      await ensure(bin, fetchImpl);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "tectonic setup failed";
      return { ok: false, reason };
    }

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "resume.tex"), latex, "utf8");

    const result = await run(bin, ["resume.tex"], dir, COMPILE_TIMEOUT_MS);
    if (result.code !== 0) {
      return {
        ok: false,
        reason: result.code === 124 ? "compile timeout" : `tectonic exit ${result.code}`,
      };
    }

    try {
      const pdf = await readFile(join(dir, "resume.pdf"));
      if (pdf.length === 0) {
        return { ok: false, reason: "empty pdf" };
      }
      return { ok: true, pdf };
    } catch {
      return { ok: false, reason: "pdf missing after compile" };
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
