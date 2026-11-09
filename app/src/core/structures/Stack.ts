// LIFO stack on an array.
// Invariantes:
// - Live elements occupy slots[0..count-1]; the top is slots[count-1].
// - Positions from count onwards are undefined, so as not to retain
//   references to already popped elements (the array does not shrink).
// - peak is the largest count observed since the stack was created.
// All operations are O(1): only the end of the array is touched.
export class Stack<T> {
  private slots: Array<T | undefined> = [];
  private count = 0;
  private peak = 0;

  // Amortized O(1): the JavaScript array grows by itself when writing at count.
  push(value: T): void {
    this.slots[this.count] = value;
    this.count += 1;
    if (this.count > this.peak) this.peak = this.count;
  }

  // O(1): removes the last one in, or undefined if the stack is empty.
  pop(): T | undefined {
    if (this.count === 0) return undefined;
    this.count -= 1;
    const value = this.slots[this.count];
    this.slots[this.count] = undefined;
    return value;
  }

  // O(1): reads the top without removing it.
  peek(): T | undefined {
    if (this.count === 0) return undefined;
    return this.slots[this.count - 1];
  }

  // O(1)
  get size(): number {
    return this.count;
  }

  // O(1)
  isEmpty(): boolean {
    return this.count === 0;
  }

  // O(1): maximum size reached.
  get peakSize(): number {
    return this.peak;
  }
}
