/**
 * Promise-based read-write lock.
 * Writer-preferring: queued writers block new readers to prevent starvation.
 */
export class ReadWriteLock {
  private readers = 0;
  private writing = false;
  private writerQueue: Array<() => void> = [];
  private readerQueue: Array<() => void> = [];

  async withRead<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireRead();
    try {
      return await fn();
    } finally {
      this.releaseRead();
    }
  }

  async withWrite<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireWrite();
    try {
      return await fn();
    } finally {
      this.releaseWrite();
    }
  }

  private acquireRead(): Promise<void> {
    // Writer-preferring: block new readers if writers are waiting
    if (!this.writing && this.writerQueue.length === 0) {
      this.readers++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.readerQueue.push(() => {
        this.readers++;
        resolve();
      });
    });
  }

  private releaseRead(): void {
    this.readers--;
    if (this.readers === 0 && this.writerQueue.length > 0) {
      this.writing = true;
      const next = this.writerQueue.shift()!;
      next();
    }
  }

  private acquireWrite(): Promise<void> {
    if (!this.writing && this.readers === 0) {
      this.writing = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.writerQueue.push(() => {
        resolve();
      });
    });
  }

  private releaseWrite(): void {
    this.writing = false;
    // Writer-preferring: prioritize queued writers over readers
    if (this.writerQueue.length > 0) {
      this.writing = true;
      const next = this.writerQueue.shift()!;
      next();
    } else if (this.readerQueue.length > 0) {
      const readers = this.readerQueue.splice(0);
      for (const r of readers) r();
    }
  }
}
