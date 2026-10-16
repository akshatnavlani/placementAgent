import { PDFParse } from "pdf-parse";

export type PdfExtractResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtractResult> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    const text = typeof result.text === "string" ? result.text : "";
    return { ok: true, text };
  } catch (error) {
    const message = error instanceof Error ? error.message : "extract failed";
    return { ok: false, reason: message };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
