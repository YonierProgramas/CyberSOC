const INITIAL_CAPACITY = 8;

// FIFO queue on a circular array (ring buffer).
// Invariantes:
// - Live elements occupy, in arrival order, the positions
//   head, head+1, …, head+count-1, all taken modulo slots.length.
// - tail === (head + count) % slots.length: it is the next free slot.
// - 0 <= count <= slots.length; slots outside that span are undefined
//   so references to already removed elements are not retained.
// - peak is the largest count observed since the queue was created; clear() does not reset it.
// Why a ring and not Array.shift(): shift moves every element (O(n)); here
// removing only advances head (O(1)).
export class Queue<T> {
  private slots: Array<T | undefined>;
  private head = 0;
  private tail = 0;
  private count = 0;
  private peak = 0;

  constructor() {
    this.slots = new Array<T | undefined>(INITIAL_CAPACITY);
  }

  // Amortized O(1): the capacity is doubled (O(n)) only when the queue is full,
  // and since each doubling pays for n earlier inserts, the average cost stays O(1).
  enqueue(value: T): void {
    if (this.count === this.slots.length) this.grow();
    this.slots[this.tail] = value;
    this.tail = (this.tail + 1) % this.slots.length;
    this.count += 1;
    if (this.count > this.peak) this.peak = this.count;
  }

  // O(1): returns the oldest element, or undefined if the queue is empty.
  dequeue(): T | undefined {
    if (this.count === 0) return undefined;
    const value = this.slots[this.head];
    this.slots[this.head] = undefined;
    this.head = (this.head + 1) % this.slots.length;
    this.count -= 1;
    return value;
  }

  // O(1): reads the oldest without removing it.
  peek(): T | undefined {
    if (this.count === 0) return undefined;
    return this.slots[this.head];
  }

  // O(1)
  get size(): number {
    return this.count;
  }

  // O(1)
  isEmpty(): boolean {
    return this.count === 0;
  }

  // O(1): returns to the initial capacity and releases all references at once.
  clear(): void {
    this.slots = new Array<T | undefined>(INITIAL_CAPACITY);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  // O(1): maximum size reached, useful to measure queue pressure.
  get peakSize(): number {
    return this.peak;
  }

  // O(n): copies the count elements in order into an array of double the size,
  // leaving the oldest at position 0. This preserves the invariant after growing.
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
