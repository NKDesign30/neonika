export class NeonResponseBodyLimitError extends Error {
  readonly code: "response-body-missing" | "response-too-large";

  constructor(code: NeonResponseBodyLimitError["code"], message: string) {
    super(message);
    this.name = "NeonResponseBodyLimitError";
    this.code = code;
  }
}

export async function readNeonResponseBodyLimited(
  body: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  if (!body) {
    throw new NeonResponseBodyLimitError("response-body-missing", "Response body is missing");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new NeonResponseBodyLimitError(
          "response-too-large",
          `Response body exceeded ${maxBytes} bytes`
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bodyBytes;
}
