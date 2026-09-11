import { promises as fs } from 'fs';

const NEWLINE = 0x0a;
const CLOSING_BRACE = 0x7d;
const CHUNK_SIZE = 1024 * 1024;

export interface TailReadResult {
  lines: string[];
  /** True when the file shrank (rewritten or truncated) and reading restarted from the beginning. */
  reset: boolean;
}

/**
 * Incrementally reads an append-only JSONL file. Each call returns only the complete lines written
 * since the previous call; a partially written trailing line is held back until it is finished.
 */
export class JsonlTailReader {
  private offset = 0;
  private pending: Buffer[] = [];

  constructor(readonly filePath: string) {}

  /** Number of bytes consumed so far, including any held-back partial line. */
  get position(): number {
    return this.offset;
  }

  async readNew(): Promise<TailReadResult> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.filePath, 'r');
    } catch (error) {
      if (isMissingFile(error)) return { lines: [], reset: false };
      throw error;
    }

    try {
      const { size } = await handle.stat();
      let reset = false;
      if (size < this.offset) {
        this.offset = 0;
        this.pending = [];
        reset = true;
      }

      const lines: string[] = [];
      while (this.offset < size) {
        const length = Math.min(CHUNK_SIZE, size - this.offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.consume(buffer.subarray(0, bytesRead), lines);
      }
      this.flushCompletePending(lines);
      return { lines, reset };
    } finally {
      await handle.close();
    }
  }

  private consume(chunk: Buffer, out: string[]): void {
    let start = 0;
    let newline = chunk.indexOf(NEWLINE, start);
    while (newline !== -1) {
      const piece = chunk.subarray(start, newline);
      const line = this.pending.length > 0 ? Buffer.concat([...this.pending, piece]) : piece;
      this.pending = [];
      if (line.length > 0) out.push(line.toString('utf8'));
      start = newline + 1;
      newline = chunk.indexOf(NEWLINE, start);
    }
    if (start < chunk.length) {
      // Copy so the (possibly large) read buffer can be released.
      this.pending.push(Buffer.from(chunk.subarray(start)));
    }
  }

  /**
   * Emits a trailing line that has no newline yet but is already a complete JSON object, so the last
   * entry of a file shows up without waiting for the next write.
   */
  private flushCompletePending(out: string[]): void {
    const last = this.pending[this.pending.length - 1];
    if (!last || last[last.length - 1] !== CLOSING_BRACE) return;
    const text = Buffer.concat(this.pending).toString('utf8');
    try {
      JSON.parse(text);
    } catch {
      return;
    }
    out.push(text);
    this.pending = [];
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
