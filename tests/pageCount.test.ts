import { describe, expect, it } from "vitest";
import { countPdfPages } from "../app/pdf/pageCount.ts";

/** Minimal 1-page PDF (pdf-parse / pdf.js accept). */
function onePagePdf(): Buffer {
  // Tiny valid PDF with one page — from pdf.js test fixtures pattern.
  const content = `%PDF-1.1
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
trailer
<< /Size 4 /Root 1 0 R >>
startxref
190
%%EOF`;
  return Buffer.from(content);
}

function twoPagePdf(): Buffer {
  const content = `%PDF-1.1
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
4 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000125 00000 n 
0000000196 00000 n 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
267
%%EOF`;
  return Buffer.from(content);
}

describe("countPdfPages", () => {
  it("counts one page", async () => {
    const result = await countPdfPages(onePagePdf());
    expect(result).toEqual({ ok: true, pages: 1 });
  });

  it("counts two pages", async () => {
    const result = await countPdfPages(twoPagePdf());
    expect(result).toEqual({ ok: true, pages: 2 });
  });

  it("rejects empty buffer", async () => {
    const result = await countPdfPages(Buffer.alloc(0));
    expect(result.ok).toBe(false);
  });
});
