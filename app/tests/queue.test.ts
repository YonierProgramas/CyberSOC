import { describe, expect, it } from 'vitest';
import { Queue } from '../src/core/structures/Queue';

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

describe('Queue', () => {
  it('sale en el mismo orden en que entro', () => {
    const queue = new Queue<number>();
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    expect(queue.peek()).toBe(1);
    expect(queue.size).toBe(3);
    expect([queue.dequeue(), queue.dequeue(), queue.dequeue()]).toEqual([
      1, 2, 3,
    ]);
    expect(queue.isEmpty()).toBe(true);
  });

  it('dequeue y peek en vacia devuelven undefined', () => {
    const queue = new Queue<string>();
    expect(queue.dequeue()).toBeUndefined();
    expect(queue.peek()).toBeUndefined();
    expect(queue.size).toBe(0);
    expect(queue.isEmpty()).toBe(true);
    expect(queue.peakSize).toBe(0);
  });

  it('da la vuelta al buffer y conserva el orden', () => {
    // La capacidad inicial es 8: al llenarla, el indice de entrada vuelve a 0.
    const queue = new Queue<number>();
    for (let value = 0; value < 8; value += 1) queue.enqueue(value);
    expect([queue.dequeue(), queue.dequeue(), queue.dequeue()]).toEqual([
      0, 1, 2,
    ]);
    queue.enqueue(8);
    queue.enqueue(9);
    queue.enqueue(10);
    expect(queue.size).toBe(8);
    const output: number[] = [];
    while (!queue.isEmpty()) {
      const value = queue.dequeue();
      if (value !== undefined) output.push(value);
    }
    expect(output).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('redimensiona con la cola dando la vuelta y no pierde elementos', () => {
    // Llena 8, saca 4 y mete 5: la quinta entrada obliga a crecer con head distinto de 0.
    const queue = new Queue<number>();
    for (let value = 0; value < 8; value += 1) queue.enqueue(value);
    for (let count = 0; count < 4; count += 1) queue.dequeue();
    for (let value = 8; value < 13; value += 1) queue.enqueue(value);
    const output: number[] = [];
    while (!queue.isEmpty()) {
      const value = queue.dequeue();
      if (value !== undefined) output.push(value);
    }
    expect(output).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('peakSize recuerda el maximo y clear no lo baja', () => {
    const queue = new Queue<number>();
    for (let value = 0; value < 5; value += 1) queue.enqueue(value);
    queue.dequeue();
    queue.dequeue();
    expect(queue.size).toBe(3);
    expect(queue.peakSize).toBe(5);
    queue.clear();
    expect(queue.isEmpty()).toBe(true);
    expect(queue.peek()).toBeUndefined();
    expect(queue.peakSize).toBe(5);
    queue.enqueue(9);
    expect(queue.dequeue()).toBe(9);
    expect(queue.peakSize).toBe(5);
  });

  it('coincide con un arreglo de referencia en operaciones aleatorias', () => {
    const next = random(0x5eed);
    const queue = new Queue<number>();
    const reference: number[] = [];
    for (let step = 0; step < 2_000; step += 1) {
      if (reference.length === 0 || next() < 0.65) {
        queue.enqueue(step);
        reference.push(step);
      } else {
        expect(queue.dequeue()).toBe(reference.shift());
      }
      expect(queue.size).toBe(reference.length);
      expect(queue.isEmpty()).toBe(reference.length === 0);
      expect(queue.peek()).toBe(reference[0]);
      expect(queue.peakSize).toBeGreaterThanOrEqual(queue.size);
    }
    while (reference.length > 0) {
      expect(queue.dequeue()).toBe(reference.shift());
    }
    expect(queue.dequeue()).toBeUndefined();
  });
});
