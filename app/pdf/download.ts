const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export type PdfDownloadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: string };

export async function downloadPdf(
  url: string,
  options: {
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<PdfDownloadResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "network error";
    return { ok: false, reason: message };
  }

  if (!response.ok) {
    return { ok: false, reason: `http ${response.status}` };
  }

  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes) {
      return { ok: false, reason: "too large" };
    }
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    return { ok: false, reason: "too large" };
  }
  return { ok: true, bytes: buffer };
}
