interface Entry<T> {
  value: T;
  score: number;
  seq: number;
}

/**
 * Bounded MIN-heap: keeps the k best seen, without storing the rest.
 * Invariant: no child is worse than its parent. The root is the WORST of the top:
 * lowest score or, on a tie, most recent arrival. So we know in O(1)
 * whom to evict if a better one arrives. A max-heap would expose the best,
 * precisely the one we want to keep, not the replacement candidate.
 * The array represents the tree: parent floor((i-1)/2), children 2*i+1 and 2*i+2.
 */
export class TopK<T> {
  private readonly heap: Entry<T>[] = [];
  private nextSeq = 0;
  private readonly k: number;
  private readonly score: (item: T) => number;

  constructor(k: number, score: (item: T) => number) {
    if (!Number.isSafeInteger(k) || k < 0)
      throw new RangeError('k must be a non-negative safe integer.');
    this.k = k;
    this.score = score;
  }

  /** O(1); never exceeds k. O(min(k, elements received)) memory. */
  get size(): number {
    return this.heap.length;
  }

  /**
   * O(log k) if it enters the top; O(1) if discarded (score is assumed O(1)).
   * The score is computed only once and stored with the arrival:
   * neither sorting nor comparing invokes score again. k=0 does not evaluate the element.
   */
  add(value: T): void {
    if (this.k === 0) return;
    const score = this.score(value);
    if (!Number.isFinite(score))
      throw new RangeError('The score must be a finite number.');
    if (this.nextSeq >= Number.MAX_SAFE_INTEGER)
      throw new RangeError('The top safe sequence is exhausted.');
    const entry = { value, score, seq: this.nextSeq++ };
    if (this.size < this.k) {
      this.heap.push(entry);
      this.siftUp(this.size - 1);
    } else if (this.worse(this.heap[0]!, entry)) {
      // Replacing only the root avoids shifting the whole array.
      this.heap[0] = entry;
      this.siftDown(0);
    }
  }

  /** O(m log m), m<=k: sorts a copy; it neither consumes nor reorders the heap. */
  values(): T[] {
    return [...this.heap]
      .sort((a, b) => b.score - a.score || a.seq - b.seq)
      .map((entry) => entry.value);
  }

  /** O(1): on ties the most recent is the first to be evicted. */
  private worse(a: Entry<T>, b: Entry<T>): boolean {
    return a.score < b.score || (a.score === b.score && a.seq > b.seq);
  }

  /** O(log k): only the new node can break the relation with its parent. */
  private siftUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.worse(this.heap[index]!, this.heap[parent]!)) break;
      [this.heap[index], this.heap[parent]] = [
        this.heap[parent]!,
        this.heap[index]!,
      ];
      index = parent;
    }
  }

  /** O(log k): sinks through the worst child until the invariant is restored. */
  private siftDown(index: number): void {
    while (2 * index + 1 < this.size) {
      const left = 2 * index + 1;
      const right = left + 1;
      const worst =
        right < this.size && this.worse(this.heap[right]!, this.heap[left]!)
          ? right
          : left;
      if (!this.worse(this.heap[worst]!, this.heap[index]!)) break;
      [this.heap[index], this.heap[worst]] = [
        this.heap[worst]!,
        this.heap[index]!,
      ];
      index = worst;
    }
  }
}

/**
 * A single traversal, even for a generator. O(n log k) selection versus
 * O(n log n) for sorting everything; afterwards only the m<=k winners are sorted.
 * Bound including k=1: O(n log(k+1) + m log(m+1)); O(m) auxiliary memory.
 * With k>=n all are returned sorted and there is no asymptotic advantage.
 */
export function topK<T>(
  items: Iterable<T>,
  k: number,
  score: (item: T) => number,
): T[] {
  const top = new TopK(k, score);
  if (k === 0) return [];
  for (const item of items) top.add(item);
  return top.values();
}
