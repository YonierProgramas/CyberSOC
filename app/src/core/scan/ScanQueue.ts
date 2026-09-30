import type { AppConfig } from '../config/AppConfig';
import { Queue } from '../structures/Queue';

export class ScanQueueClosedError extends Error {
  constructor() {
    super('La cola de escaneo está cerrada.');
  }
}

/** close preserves queued items for consumers; close + drain discards pending work. */
export class ScanQueue<T> {
  private readonly items = new Queue<T>();
  private readonly changed = new Set<() => void>();
  private readonly blocked = new Map<symbol, number>();
  private closed = false;
  private blockedMs = 0;
  readonly capacity: number;

  constructor(
    config: Pick<AppConfig, 'scan'>,
    private readonly now = () => performance.now(),
  ) {
    this.capacity = config.scan.queueCapacity;
    if (!Number.isSafeInteger(this.capacity) || this.capacity <= 0) {
      throw new RangeError('La capacidad debe ser un entero positivo seguro.');
    }
  }

  get size(): number {
    return this.items.size;
  }
  get peakSize(): number {
    return this.items.peakSize;
  }
  get producerBlockedMs(): number {
    const now = this.now();
    return (
      this.blockedMs +
      [...this.blocked.values()].reduce(
        (sum, start) => sum + Math.max(0, now - start),
        0,
      )
    );
  }

  async put(value: T, signal?: AbortSignal): Promise<void> {
    if (value === undefined)
      throw new TypeError('undefined está reservado para el fin de la cola.');
    let token: symbol | undefined;
    try {
      while (true) {
        signal?.throwIfAborted();
        if (this.closed) throw new ScanQueueClosedError();
        if (this.items.size < this.capacity) {
          this.items.enqueue(value);
          this.notify();
          return;
        }
        if (token === undefined) {
          token = Symbol();
          this.blocked.set(token, this.now());
        }
        await this.wait(signal);
      }
    } finally {
      if (token !== undefined) {
        this.blockedMs += Math.max(0, this.now() - this.blocked.get(token)!);
        this.blocked.delete(token);
      }
    }
  }

  async take(signal?: AbortSignal): Promise<T | undefined> {
    while (true) {
      signal?.throwIfAborted();
      if (!this.items.isEmpty()) {
        const value = this.items.dequeue();
        this.notify();
        return value;
      }
      if (this.closed) return undefined;
      await this.wait(signal);
    }
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  drain(): T[] {
    const values: T[] = [];
    while (!this.items.isEmpty()) values.push(this.items.dequeue()!);
    this.notify();
    return values;
  }

  private notify(): void {
    for (const wake of [...this.changed]) wake();
  }

  private wait(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        this.changed.delete(wake);
        signal?.removeEventListener('abort', wake);
        resolve();
      };
      this.changed.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
    });
  }
}
