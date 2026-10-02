interface Entry<T> {
  value: T;
  score: number;
  seq: number;
}

/**
 * MIN-heap acotado: conserva los k mejores vistos, sin guardar el resto.
 * Invariante: ningún hijo es peor que su padre. La raíz es el PEOR del top:
 * menor puntuación o, en empate, llegada más reciente. Así sabemos en O(1)
 * a quién expulsar si llega uno mejor. Un max-heap expondría al mejor,
 * precisamente el que queremos conservar, no al candidato a reemplazar.
 * El arreglo representa el árbol: padre floor((i-1)/2), hijos 2*i+1 y 2*i+2.
 */
export class TopK<T> {
  private readonly heap: Entry<T>[] = [];
  private nextSeq = 0;
  private readonly k: number;
  private readonly score: (item: T) => number;

  constructor(k: number, score: (item: T) => number) {
    if (!Number.isSafeInteger(k) || k < 0)
      throw new RangeError('k debe ser un entero seguro no negativo.');
    this.k = k;
    this.score = score;
  }

  /** O(1); nunca supera k. Memoria O(min(k, elementos recibidos)). */
  get size(): number {
    return this.heap.length;
  }

  /**
   * O(log k) si entra al top; O(1) si se descarta (score se supone O(1)).
   * La puntuación se calcula una sola vez y se guarda junto a la llegada:
   * ni ordenar ni comparar vuelve a invocar score. k=0 no evalúa el elemento.
   */
  add(value: T): void {
    if (this.k === 0) return;
    const score = this.score(value);
    if (!Number.isFinite(score))
      throw new RangeError('La puntuación debe ser un número finito.');
    if (this.nextSeq >= Number.MAX_SAFE_INTEGER)
      throw new RangeError('Se agotó la secuencia segura del top.');
    const entry = { value, score, seq: this.nextSeq++ };
    if (this.size < this.k) {
      this.heap.push(entry);
      this.siftUp(this.size - 1);
    } else if (this.worse(this.heap[0]!, entry)) {
      // Reemplazar solo la raíz evita desplazar el arreglo completo.
      this.heap[0] = entry;
      this.siftDown(0);
    }
  }

  /** O(m log m), m<=k: ordena una copia; no consume ni reordena el heap. */
  values(): T[] {
    return [...this.heap]
      .sort((a, b) => b.score - a.score || a.seq - b.seq)
      .map((entry) => entry.value);
  }

  /** O(1): en empates el más reciente es el primero que se expulsa. */
  private worse(a: Entry<T>, b: Entry<T>): boolean {
    return a.score < b.score || (a.score === b.score && a.seq > b.seq);
  }

  /** O(log k): solo el nuevo nodo puede romper la relación con su padre. */
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

  /** O(log k): baja por el peor hijo hasta restaurar la invariante. */
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
 * Un solo recorrido, incluso para un generador. Selección O(n log k) frente
 * a O(n log n) de ordenar todo; después solo ordenamos los m<=k ganadores.
 * Cota incluyendo k=1: O(n log(k+1) + m log(m+1)); memoria auxiliar O(m).
 * Con k>=n se devuelven todos ordenados y no hay ventaja asintótica.
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
