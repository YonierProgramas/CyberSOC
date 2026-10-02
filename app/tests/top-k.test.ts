import { describe, expect, it, vi } from 'vitest';
import { TopK, topK } from '../src/core/structures/TopK';

describe('topK: min-heap estable', () => {
  it('k=0 no consume el iterable ni evalúa puntuaciones', () => {
    const score = vi.fn(() => 1);
    const iterator = vi.fn(() => [1, 2][Symbol.iterator]());
    expect(topK({ [Symbol.iterator]: iterator }, 0, score)).toEqual([]);
    expect(iterator).not.toHaveBeenCalled();
    expect(score).not.toHaveBeenCalled();
  });

  it('vacío, un elemento y k>n; no modifica la entrada', () => {
    expect(topK([], 10, Number)).toEqual([]);
    expect(topK([7], 1, Number)).toEqual([7]);
    const input = Object.freeze([2, -5, 9, 3]);
    expect(topK(input, 20, Number)).toEqual([9, 3, 2, -5]);
    expect(input).toEqual([2, -5, 9, 3]);
  });

  it('k=1 conserva al primero entre los máximos', () => {
    const items = [
      { id: 0, s: 8 },
      { id: 1, s: 9 },
      { id: 2, s: 9 },
    ];
    expect(topK(items, 1, (item) => item.s)).toEqual([items[1]]);
  });

  it('los empates en la frontera expulsan al más reciente del top', () => {
    const items = [5, 5, 5, 9, 5, 9].map((s, id) => ({ id, s }));
    expect(topK(items, 3, (item) => item.s).map((item) => item.id)).toEqual([
      3, 5, 0,
    ]);
    expect(topK(items.slice(0, 3), 2, (item) => item.s)).toEqual(
      items.slice(0, 2),
    );
  });

  it('consume un generador una vez y calcula cada puntuación una sola vez', () => {
    function* input() {
      yield 3;
      yield 8;
      yield 1;
      yield 5;
    }
    const score = vi.fn((value: number) => value);
    expect(topK(input(), 2, score)).toEqual([8, 5]);
    expect(score.mock.calls.map(([value]) => value)).toEqual([3, 8, 1, 5]);
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rechaza k inválido %s',
    (k) => expect(() => topK([1], k, Number)).toThrow(RangeError),
  );
  it.each([NaN, Infinity, -Infinity])('rechaza score no finito %s', (score) => {
    expect(() => topK([1], 1, () => score)).toThrow(RangeError);
  });

  it('incremental: tamaño acotado, snapshots independientes y score capturado', () => {
    const score = vi.fn((item: { id: number; s: number }) => item.s);
    const heap = new TopK(3, score);
    const first = { id: 0, s: 100 };
    heap.add(first);
    const snapshot = heap.values();
    first.s = -100; // La prioridad capturada sigue siendo 100.
    for (let i = 1; i <= 100; i++) {
      heap.add({ id: i, s: i });
      expect(heap.size).toBeLessThanOrEqual(3);
    }
    expect(heap.values().map((item) => item.id)).toEqual([0, 100, 99]);
    expect(snapshot).toEqual([first]);
    snapshot.length = 0;
    expect(heap.size).toBe(3);
    expect(score).toHaveBeenCalledTimes(101);
  });

  it('coincide con ordenar todo en 1 000 casos aleatorios reproducibles', () => {
    let seed = 0x5a17;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let trial = 0; trial < 1000; trial++) {
      const n = random() % 251;
      const k = random() % (n + 20);
      // Muchos empates, ceros y negativos; id es el orden original.
      const items = Array.from({ length: n }, (_, id) => ({
        id,
        s: (random() % 41) - 20,
      }));
      const expected = [...items]
        .sort((a, b) => b.s - a.s || a.id - b.id)
        .slice(0, k);
      expect(
        topK(items, k, (item) => item.s),
        `caso ${trial}`,
      ).toEqual(expected);
      const heap = new TopK(k, (item: (typeof items)[number]) => item.s);
      for (const item of items) {
        heap.add(item);
        expect(heap.size).toBeLessThanOrEqual(k);
      }
      expect(heap.values(), `incremental ${trial}`).toEqual(expected);
    }
  });
});
