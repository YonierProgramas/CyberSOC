const INITIAL_CAPACITY = 8;

// Cola FIFO sobre un arreglo circular (búfer en anillo).
// Invariantes:
// - Los elementos vivos ocupan, en orden de llegada, las posiciones
//   head, head+1, …, head+count-1, todas tomadas módulo slots.length.
// - tail === (head + count) % slots.length: es la próxima casilla libre.
// - 0 <= count <= slots.length; las casillas fuera de ese tramo valen undefined
//   para no retener referencias a elementos ya retirados.
// - peak es el mayor count observado desde que se creó la cola; clear() no lo reinicia.
// Por qué un anillo y no Array.shift(): shift mueve todos los elementos (O(n)); aquí
// retirar solo avanza head (O(1)).
export class Queue<T> {
  private slots: Array<T | undefined>;
  private head = 0;
  private tail = 0;
  private count = 0;
  private peak = 0;

  constructor() {
    this.slots = new Array<T | undefined>(INITIAL_CAPACITY);
  }

  // O(1) amortizado: solo cuando la cola está llena se duplica la capacidad (O(n)),
  // y como cada duplicación paga n inserciones previas, el costo medio sigue siendo O(1).
  enqueue(value: T): void {
    if (this.count === this.slots.length) this.grow();
    this.slots[this.tail] = value;
    this.tail = (this.tail + 1) % this.slots.length;
    this.count += 1;
    if (this.count > this.peak) this.peak = this.count;
  }

  // O(1): devuelve el elemento más antiguo, o undefined si la cola está vacía.
  dequeue(): T | undefined {
    if (this.count === 0) return undefined;
    const value = this.slots[this.head];
    this.slots[this.head] = undefined;
    this.head = (this.head + 1) % this.slots.length;
    this.count -= 1;
    return value;
  }

  // O(1): consulta el más antiguo sin retirarlo.
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

  // O(1): vuelve a la capacidad inicial y suelta todas las referencias de una vez.
  clear(): void {
    this.slots = new Array<T | undefined>(INITIAL_CAPACITY);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  // O(1): tamaño máximo alcanzado, útil para medir la presión de la cola.
  get peakSize(): number {
    return this.peak;
  }

  // O(n): copia los count elementos en orden a un arreglo del doble de tamaño,
  // dejando el más antiguo en la posición 0. Así se conserva el invariante tras crecer.
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
