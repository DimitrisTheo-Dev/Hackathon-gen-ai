import { EngineError } from "./errors.js";

/** Upper bound for JSON request bodies on `/v1` and `/mcp`. The largest legitimate body (a director turn with history) is far below it. */
export const MAX_BODY_BYTES = 256 * 1024;

function tooLarge(maxBytes: number) {
  return new EngineError("validation_error", `The request is too large. Bodies are limited to ${maxBytes / 1024} KB.`, { status: 413 });
}

/**
 * Reads a request body as UTF-8 text, refusing it (413) as soon as it exceeds `maxBytes`. A declared
 * Content-Length over the limit is refused without reading anything, and a body without one (chunked) is
 * cut off at the limit rather than buffered whole — so memory per request stays bounded. Bytes are counted,
 * not UTF-16 code units.
 */
export async function readBoundedText(request: Request, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
