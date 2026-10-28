import { PDFParse } from "pdf-parse";

export type PageCountResult =
  | { ok: true; pages: number }
  | { ok: false; reason: string };

/**
 * Count pages in a compiled resume PDF via pdf-parse.
 */
export async function countPdfPages(bytes: Uint8Array | Buffer): Promise<PageCountResult> {
  const data = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  if (data.length === 0) {
    return { ok: false, reason: "empty pdf" };
  }
  const parser = new PDFParse({ data });
  try {
    const info = await parser.getInfo();
    const pages = typeof info.total === "number" ? info.total : Number.NaN;
    if (!Number.isFinite(pages) || pages < 1) {
      return { ok: false, reason: "page count unavailable" };
    }
    return { ok: true, pages: Math.floor(pages) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "page count failed";
    return { ok: false, reason: message };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
