import type { Readable } from "node:stream";

export const NEON_NDJSON_MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface INeonBoundedLineReaderOptions {
  readonly input: Readable;
  readonly errorLabel: string;
  readonly maxLineBytes?: number | undefined;
  readonly onLine: (line: string) => void;
  readonly onError: (error: Error) => void;
}

export class NeonBoundedLineReader {
  private readonly input: Readable;
  private readonly errorLabel: string;
  private readonly maxLineBytes: number;
  private readonly onLine: (line: string) => void;
  private readonly onError: (error: Error) => void;
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private closed = false;

  private readonly handleDataBound = (chunk: Buffer | string): void => {
    this.handleData(chunk);
  };

  private readonly handleEndBound = (): void => {
    this.handleEnd();
  };

  private readonly handleInputErrorBound = (error: Error): void => {
    this.fail(error);
  };

  constructor(options: INeonBoundedLineReaderOptions) {
    this.input = options.input;
    this.errorLabel = options.errorLabel;
    this.maxLineBytes = options.maxLineBytes ?? NEON_NDJSON_MAX_LINE_BYTES;
    this.onLine = options.onLine;
    this.onError = options.onError;

    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1) {
      throw new Error(`${this.errorLabel} requires a positive max line byte limit`);
    }

    this.input.on("data", this.handleDataBound);
    this.input.once("end", this.handleEndBound);
    this.input.once("error", this.handleInputErrorBound);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.input.off("data", this.handleDataBound);
    this.input.off("end", this.handleEndBound);
    this.input.off("error", this.handleInputErrorBound);
    this.chunks.length = 0;
    this.bufferedBytes = 0;
  }

  private handleData(rawChunk: Buffer | string): void {
    if (this.closed) {
      return;
    }

    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk, "utf8");
    let start = 0;

    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) {
        continue;
      }

      if (!this.appendChunk(chunk.subarray(start, index))) {
        return;
      }

      this.emitBufferedLine();
      if (this.closed) {
        return;
      }

      start = index + 1;
    }

    if (start < chunk.length) {
      this.appendChunk(chunk.subarray(start));
    }
  }

  private handleEnd(): void {
    if (this.closed || this.bufferedBytes === 0) {
      return;
    }

    this.emitBufferedLine();
  }

  private appendChunk(chunk: Buffer): boolean {
    if (chunk.length === 0) {
      return true;
    }

    if (this.closed) {
      return false;
    }

    if (this.bufferedBytes + chunk.length > this.maxLineBytes) {
      this.fail(new Error(`${this.errorLabel} exceeded max stdout line size: maxBytes=${this.maxLineBytes}`));
      return false;
    }

    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;

    return true;
  }

  private emitBufferedLine(): void {
    if (this.closed) {
      return;
    }

    const line = Buffer.concat(this.chunks, this.bufferedBytes)
      .toString("utf8")
      .replace(/\r$/u, "");
    this.chunks.length = 0;
    this.bufferedBytes = 0;
    this.onLine(line);
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }

    this.close();
    this.onError(error);
  }
}
