export class Stack<T> {
  private slots: Array<T | undefined> = [];
  private count = 0;
  private peak = 0;

  push(value: T): void {
    this.slots[this.count] = value;
    this.count += 1;
    if (this.count > this.peak) this.peak = this.count;
  }

  pop(): T | undefined {
    if (this.count === 0) return undefined;
    this.count -= 1;
    const value = this.slots[this.count];
    this.slots[this.count] = undefined;
    return value;
  }

  peek(): T | undefined {
    if (this.count === 0) return undefined;
    return this.slots[this.count - 1];
  }

  get size(): number {
    return this.count;
  }

  isEmpty(): boolean {
    return this.count === 0;
  }

  get peakSize(): number {
    return this.peak;
  }
}
