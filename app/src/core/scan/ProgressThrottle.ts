/** Latest-value throttling, including the final flush: at most one emission per 200 ms. */
export class ProgressThrottle<T> {
  private last = -Infinity;
  private pending: { value: T } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushed = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly emit: (value: T) => void,
    private readonly now = () => performance.now(),
  ) {}

  push(value: T): void {
    if (this.disposed) return;
    this.pending = { value };
    const remaining = 200 - (this.now() - this.last);
    if (remaining <= 0) this.deliver();
    else if (this.timer === null)
      this.timer = setTimeout(() => this.deliver(), remaining);
  }

  flush(): Promise<void> {
    if (this.pending === null) return Promise.resolve();
    return new Promise((resolve) => this.flushed.add(resolve));
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.resolveFlush();
  }

  private deliver(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    this.last = this.now();
    try {
      if (pending !== null) this.emit(pending.value);
    } finally {
      this.resolveFlush();
    }
  }

  private resolveFlush(): void {
    for (const resolve of this.flushed) resolve();
    this.flushed.clear();
  }
}
