const INITIAL_CAPACITY = 8;

export class Queue<T> {
  private slots: Array<T | undefined>;
  private head = 0;
  private tail = 0;
  private count = 0;
  private peak = 0;

  constructor() {
    this.slots = new Array<T | undefined>(INITIAL_CAPACITY);
  }

  enqueue(value: T): void {
    if (this.count === this.slots.length) this.grow();
    this.slots[this.tail] = value;
    this.tail = (this.tail + 1) % this.slots.length;
    this.count += 1;
    if (this.count > this.peak) this.peak = this.count;
  }

  dequeue(): T | undefined {
    if (this.count === 0) return undefined;
    const value = this.slots[this.head];
    this.slots[this.head] = undefined;
    this.head = (this.head + 1) % this.slots.length;
    this.count -= 1;
    return value;
  }

  peek(): T | undefined {
    if (this.count === 0) return undefined;
    return this.slots[this.head];
  }

  get size(): number {
    return this.count;
  }

  isEmpty(): boolean {
    return this.count === 0;
  }

  clear(): void {
    this.slots = new Array<T | undefined>(INITIAL_CAPACITY);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  get peakSize(): number {
    return this.peak;
  }

  private grow(): void {
    const grown = new Array<T | undefined>(this.slots.length * 2);
    for (let offset = 0; offset < this.count; offset += 1) {
      grown[offset] = this.slots[(this.head + offset) % this.slots.length];
    }
    this.slots = grown;
    this.head = 0;
    this.tail = this.count;
  }
}
