import { describe, expect, it } from 'vitest';
import { PriorityQueue } from '../src/core/structures/PriorityQueue';

describe('PriorityQueue: max-heap estable', () => {
  it('vacía, un elemento y peakSize conservado', () => {
    const queue = new PriorityQueue<string>();
    expect(queue.size).toBe(0);
    expect(queue.peakSize).toBe(0);
    expect(queue.isEmpty()).toBe(true);
    expect(queue.pop()).toBeUndefined();
    expect(queue.peek()).toBeUndefined();
    queue.push('único', -3);
    expect(queue.peek()).toBe('único');
    expect(queue.size).toBe(1);
    expect(queue.peakSize).toBe(1);
    expect(queue.pop()).toBe('único');
    expect(queue.isEmpty()).toBe(true);
    expect(queue.peakSize).toBe(1);
  });

  it('muchos empates salen FIFO incluso después de insertar más', () => {
    const queue = new PriorityQueue<number>();
    for (let i = 0; i < 1000; i++) queue.push(i, 10);
    for (let i = 0; i < 400; i++) expect(queue.pop()).toBe(i);
    for (let i = 1000; i < 1400; i++) queue.push(i, 10);
    for (let i = 400; i < 1400; i++) expect(queue.pop()).toBe(i);
    expect(queue.peakSize).toBe(1000);
    expect(queue.size).toBe(0);
  });

  it('prioridades negativas y decimales; la prioridad se captura al insertar', () => {
    const queue = new PriorityQueue<{ name: string; priority: number }>();
    const first = { name: 'A', priority: 2.5 };
    queue.push(first, first.priority);
    queue.push({ name: 'B', priority: -1 }, -1);
    queue.push({ name: 'C', priority: 3 }, 3);
    first.priority = 900;
    expect(queue.pop()?.name).toBe('C');
    expect(queue.pop()).toBe(first);
    expect(queue.pop()?.name).toBe('B');
  });

  it('permite valores falsy o undefined, con tamaño independiente del valor', () => {
    const queue = new PriorityQueue<number | boolean | undefined>();
    queue.push(false, 1);
    queue.push(0, 2);
    queue.push(undefined, 3);
    expect(queue.peek()).toBeUndefined();
    expect(queue.size).toBe(3);
    expect(queue.pop()).toBeUndefined();
    expect(queue.pop()).toBe(0);
    expect(queue.pop()).toBe(false);
    expect(queue.isEmpty()).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity])(
    'rechaza prioridad no finita: %s',
    (priority) => {
      const queue = new PriorityQueue<string>();
      queue.push('válido', 1);
      expect(() => queue.push('inválido', priority)).toThrow(RangeError);
      expect(queue.size).toBe(1);
      expect(queue.peakSize).toBe(1);
      expect(queue.pop()).toBe('válido');
    },
  );

  it.each([1, 42, 98765, 0xdeadbeef])(
    'propiedad: máximo y FIFO tras operaciones intercaladas (semilla %s)',
    (seed) => {
      const queue = new PriorityQueue<number>();
      // Oráculo independiente: ordenar una lista completa, sin usar un heap.
      const expected: { value: number; priority: number; seq: number }[] = [];
      let randomState = seed;
      let seq = 0;
      let peak = 0;
      const random = () => {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
        return randomState;
      };
      const sort = () =>
        expected.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      for (let step = 0; step < 3000; step++) {
        if (expected.length === 0 || random() % 3 !== 0) {
          const priority = (random() % 21) - 10; // Muchos empates.
          queue.push(seq, priority);
          expected.push({ value: seq, priority, seq });
          seq++;
          peak = Math.max(peak, expected.length);
        } else {
          sort();
          expect(queue.pop()).toBe(expected.shift()!.value);
        }
        sort();
        expect(queue.peek()).toBe(expected[0]?.value);
        expect(queue.size).toBe(expected.length);
        expect(queue.isEmpty()).toBe(expected.length === 0);
        expect(queue.peakSize).toBe(peak);
      }
      for (const item of sort()) expect(queue.pop()).toBe(item.value);
      expect(queue.pop()).toBeUndefined();
      expect(queue.size).toBe(0);
      expect(queue.peakSize).toBe(peak);
    },
  );
});
