import { appendFile, chmod, rename, stat, unlink } from "fs/promises";
import { mkdirSync } from "fs";
import { dirname } from "path";

export class RotatingLog {
  private filePath: string;
  private maxBytes: number;
  private maxFiles: number;
  private currentSize: number | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, maxBytes = 10 * 1024 * 1024, maxFiles = 3) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  }

  async append(message: string): Promise<void> {
    const op = this.writeQueue.then(async () => {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      if (this.currentSize === null) {
        try {
          const s = await stat(this.filePath);
          this.currentSize = s.size;
        } catch {
          this.currentSize = 0;
        }
      }

      const bytes = Buffer.byteLength(message, "utf-8");

      if (this.currentSize + bytes > this.maxBytes) {
        await this.rotate();
      }

      const isNewFile = this.currentSize === 0;
      await appendFile(this.filePath, message, { mode: 0o600 });
      if (isNewFile) {
        try {
          await chmod(this.filePath, 0o600);
        } catch {
          // The file may have been removed during test teardown; the write itself already succeeded or failed above.
        }
      }
      this.currentSize! += bytes;
    });
    this.writeQueue = op.catch(() => {});
    return op;
  }

  private async rotate(): Promise<void> {
    // Delete the oldest file if it exists
    try {
      await unlink(`${this.filePath}.${this.maxFiles}`);
    } catch { /* may not exist */ }

    // Shift numbered files: .2 -> .3, .1 -> .2
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      try {
        await rename(`${this.filePath}.${i}`, `${this.filePath}.${i + 1}`);
      } catch { /* may not exist */ }
    }

    // Rename current file to .1
    try {
      await rename(this.filePath, `${this.filePath}.1`);
      try {
        await chmod(`${this.filePath}.1`, 0o600);
      } catch {
        // Best-effort only.
      }
    } catch { /* may not exist */ }

    this.currentSize = 0;
  }
}
