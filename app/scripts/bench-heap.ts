import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { PriorityQueue } from '../src/core/structures/PriorityQueue.ts';

interface Item {
  value: number;
  priority: number;
  seq: number;
}

const count = 50_000;
const repetitions = 3;
let seed = 42;
const input: Item[] = Array.from({ length: count }, (_, seq) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return { value: seq, priority: seed % 201, seq };
});

// The best ends up last: highest priority; on a tie, lowest sequence.
// Finding the position costs O(log n), but splice shifts O(n) elements.
// pop costs O(1). Therefore n inserts can cost O(n²).
function arrayRound(items: Item[]): number[] {
  const sorted: Item[] = [];
  for (const item of items) {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = sorted[mid]!;
      const order =
        candidate.priority - item.priority || item.seq - candidate.seq;
      if (order <= 0) low = mid + 1;
      else high = mid;
    }
    sorted.splice(low, 0, item);
  }
  const output: number[] = [];
  while (sorted.length) output.push(sorted.pop()!.value);
  return output;
}

function heapRound(items: Item[]): number[] {
  const heap = new PriorityQueue<number>();
  for (const item of items) heap.push(item.value, item.priority);
  const output: number[] = [];
  while (!heap.isEmpty()) output.push(heap.pop()!);
  return output;
}

// Oracle outside the measured time; checks order and FIFO, not just a sum.
const expected = [...input]
  .sort((a, b) => b.priority - a.priority || a.seq - b.seq)
  .map((item) => item.value);
for (const round of [heapRound, arrayRound]) round(input.slice(0, 1000));

function measure(round: (items: Item[]) => number[]): number {
  const start = performance.now();
  const result = round(input);
  const elapsed = performance.now() - start;
  assert.deepEqual(result, expected);
  return elapsed;
}
const heapTimes: number[] = [];
const arrayTimes: number[] = [];
for (let i = 0; i < repetitions; i++) {
  if (i % 2 === 0) {
    heapTimes.push(measure(heapRound));
    arrayTimes.push(measure(arrayRound));
  } else {
    arrayTimes.push(measure(arrayRound));
    heapTimes.push(measure(heapRound));
  }
}
function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}
const heapMs = median(heapTimes);
const arrayMs = median(arrayTimes);
console.log('CyberSOC — max-heap estable frente a arreglo ordenado');
console.log('Fecha UTC:', new Date().toISOString());
console.log('Entorno:', process.platform, process.arch, process.version);
console.log('CPU:', cpus()[0]?.model ?? 'desconocida');
console.log(
  'Operations per repetition and algorithm:',
  count,
  'inserciones +',
  count,
  'extracciones',
);
console.log('Repeticiones:', repetitions, '(mediana; orden alternado)');
console.log(
  'Corpus determinista; prioridades 0..200, muchos empates; secuencia de llegada.',
);
console.log(
  'Array: binary insertion + splice, best at the end + pop; no sort per insertion.',
);
console.log(
  'Measurement includes build and drain; excludes corpus, oracle and validation.',
);
console.log(
  'Equivalence: PASS; 50000 results in priority and FIFO order, on each repetition.',
);
console.log('Heap (ms):', heapTimes.map((ms) => ms.toFixed(3)).join(', '));
console.log('Arreglo (ms):', arrayTimes.map((ms) => ms.toFixed(3)).join(', '));
console.log('Mediana heap:', heapMs.toFixed(3), 'ms');
console.log('Mediana arreglo:', arrayMs.toFixed(3), 'ms');
console.log('Array/heap ratio:', (arrayMs / heapMs).toFixed(2) + 'x');
console.log(
  'Synthetic measurement; does not predict AI latency or an advantage with small queues.',
);
