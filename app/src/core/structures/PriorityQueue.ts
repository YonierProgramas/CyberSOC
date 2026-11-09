interface Entry<T> {
  value: T;
  priority: number;
  seq: number;
}

/**
 * Stable max-heap: no child precedes its parent. Higher priority wins;
 * on a tie the lower seq wins (arrived first). The root is always the next one.
 * The array represents the tree without pointers: parent floor((i - 1) / 2),
 * left child 2*i + 1, right child 2*i + 2. O(n) memory.
 */
export class PriorityQueue<T> {
  private readonly heap: Entry<T>[] = [];
  private nextSeq = 0;
  private peak = 0;

  /** O(1): number of elements still in the heap. */
  get size(): number {
    return this.heap.length;
  }

  /** O(1): maximum size observed; it does not decrease on extraction. */
  get peakSize(): number {
    return this.peak;
  }

  /** O(1). */
  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /** O(1): reads the root without extracting it. */
  peek(): T | undefined {
    return this.heap[0]?.value;
  }

  /**
   * O(log n) amortized: appending to the array is amortized O(1) and siftUp
   * climbs at most the logarithmic height of the tree. We capture priority
   * and seq: later changes to the value object do not alter the heap order.
   */
  push(value: T, priority: number): void {
    if (!Number.isFinite(priority))
      throw new RangeError('Priority must be a finite number.');
    if (this.nextSeq >= Number.MAX_SAFE_INTEGER)
      throw new RangeError('The queue safe sequence is exhausted.');
    this.heap.push({ value, priority, seq: this.nextSeq++ });
    this.peak = Math.max(this.peak, this.size);
    this.siftUp(this.size - 1);
  }

  /**
   * O(log n): replaces the root with the last node and sinks it until
   * the invariant is restored. Array pop avoids the O(n) shift displacement.
   */
  pop(): T | undefined {
    if (this.isEmpty()) return undefined;
    const first = this.heap[0]!;
    const last = this.heap.pop()!;
    if (!this.isEmpty()) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return first.value;
  }

  /** O(1): total order by descending priority and ascending arrival. */
  private precedes(a: Entry<T>, b: Entry<T>): boolean {
    return (
      a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)
    );
  }

  /** O(log n): only the relation of the new node with its parent can fail. */
  private siftUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.precedes(this.heap[index]!, this.heap[parent]!)) break;
      [this.heap[index], this.heap[parent]] = [
        this.heap[parent]!,
        this.heap[index]!,
      ];
      index = parent;
    }
  }

  /** O(log n): swapping with the best child keeps the order between subtrees. */
  private siftDown(index: number): void {
    while (2 * index + 1 < this.size) {
      const left = 2 * index + 1;
      const right = left + 1;
      const best =
        right < this.size && this.precedes(this.heap[right]!, this.heap[left]!)
          ? right
          : left;
      if (!this.precedes(this.heap[best]!, this.heap[index]!)) break;
      [this.heap[index], this.heap[best]] = [
        this.heap[best]!,
        this.heap[index]!,
      ];
      index = best;
    }
  }
}
