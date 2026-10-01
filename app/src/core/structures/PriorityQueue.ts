interface Entry<T> {
  value: T;
  priority: number;
  seq: number;
}

/**
 * Max-heap estable: ningún hijo precede a su padre. Gana mayor prioridad;
 * en empate gana menor seq (llegó antes). La raíz siempre es el siguiente.
 * El arreglo representa el árbol sin punteros: padre floor((i - 1) / 2),
 * hijo izquierdo 2*i + 1, derecho 2*i + 2. Memoria O(n).
 */
export class PriorityQueue<T> {
  private readonly heap: Entry<T>[] = [];
  private nextSeq = 0;
  private peak = 0;

  /** O(1): cantidad de elementos aún en el heap. */
  get size(): number {
    return this.heap.length;
  }

  /** O(1): máximo tamaño observado; no disminuye al extraer. */
  get peakSize(): number {
    return this.peak;
  }

  /** O(1). */
  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /** O(1): consulta la raíz sin extraerla. */
  peek(): T | undefined {
    return this.heap[0]?.value;
  }

  /**
   * O(log n) amortizado: añadir al arreglo es O(1) amortizado y siftUp
   * sube como máximo la altura logarítmica del árbol. Capturamos priority
   * y seq: modificar después el objeto value no cambia el orden del heap.
   */
  push(value: T, priority: number): void {
    if (!Number.isFinite(priority))
      throw new RangeError('La prioridad debe ser un número finito.');
    if (this.nextSeq >= Number.MAX_SAFE_INTEGER)
      throw new RangeError('Se agotó la secuencia segura de la cola.');
    this.heap.push({ value, priority, seq: this.nextSeq++ });
    this.peak = Math.max(this.peak, this.size);
    this.siftUp(this.size - 1);
  }

  /**
   * O(log n): sustituye la raíz por el último nodo y baja hasta restaurar
   * la invariante. pop del arreglo evita el desplazamiento O(n) de shift.
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

  /** O(1): orden total por prioridad descendente y llegada ascendente. */
  private precedes(a: Entry<T>, b: Entry<T>): boolean {
    return (
      a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)
    );
  }

  /** O(log n): únicamente la relación del nuevo nodo con su padre puede fallar. */
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

  /** O(log n): intercambiar con el mejor hijo conserva el orden entre subárboles. */
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
