// Pila LIFO sobre un arreglo.
// Invariantes:
// - Los elementos vivos ocupan slots[0..count-1]; el tope es slots[count-1].
// - Las posiciones desde count en adelante valen undefined, para no retener
//   referencias a elementos ya sacados (el arreglo no se encoge).
// - peak es el mayor count observado desde que se creó la pila.
// Todas las operaciones son O(1): solo se toca el extremo final del arreglo.
export class Stack<T> {
  private slots: Array<T | undefined> = [];
  private count = 0;
  private peak = 0;

  // O(1) amortizado: el arreglo de JavaScript crece por sí mismo al escribir en count.
  push(value: T): void {
    this.slots[this.count] = value;
    this.count += 1;
    if (this.count > this.peak) this.peak = this.count;
  }

  // O(1): saca el último que entró, o undefined si la pila está vacía.
  pop(): T | undefined {
    if (this.count === 0) return undefined;
    this.count -= 1;
    const value = this.slots[this.count];
    this.slots[this.count] = undefined;
    return value;
  }

  // O(1): consulta el tope sin sacarlo.
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

  // O(1): tamaño máximo alcanzado.
  get peakSize(): number {
    return this.peak;
  }
}
