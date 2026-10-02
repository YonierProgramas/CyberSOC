import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { topK } from '../src/core/structures/TopK.ts';

const n = 100_000;
const k = 10;
const repetitions = 7;
let seed = 0x5a17;
const items = Array.from({ length: n }, (_, id) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return { id, score: seed % 101 };
});
const score = (item: (typeof items)[number]) => item.score;
const heap = () => topK(items, k, score);
const sort = () =>
  [...items].sort((a, b) => score(b) - score(a) || a.id - b.id).slice(0, k);
const expected = sort();
// Calentamiento y oráculo fuera del intervalo medido. Ambas rutas devuelven
// los mismos diez objetos ordenados; sort incluye su copia, sin mutar el corpus.
for (let i = 0; i < 3; i++) {
  heap();
  sort();
}
function measure(run: typeof heap): number {
  const start = performance.now();
  const result = run();
  const ms = performance.now() - start;
  assert.deepEqual(result, expected);
  return ms;
}
const heapTimes: number[] = [];
const sortTimes: number[] = [];
for (let i = 0; i < repetitions; i++) {
  if (i % 2 === 0) {
    heapTimes.push(measure(heap));
    sortTimes.push(measure(sort));
  } else {
    sortTimes.push(measure(sort));
    heapTimes.push(measure(heap));
  }
}
const median = (times: number[]) =>
  [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
const heapMs = median(heapTimes),
  sortMs = median(sortTimes);
console.log('CyberSOC — top-10 de 100 000 elementos: min-heap frente a sort');
console.log('Fecha UTC:', new Date().toISOString());
console.log(
  'Entorno:',
  process.platform,
  process.arch,
  process.version,
  cpus()[0]?.model,
);
console.log(
  'Corpus determinista: semilla 0x5a17, puntuaciones 0..100, empates FIFO.',
);
console.log(
  'Repeticiones:',
  repetitions,
  '(3 calentamientos, orden alternado, mediana)',
);
console.log(
  'Incluye selección y orden de salida; excluye creación del corpus y validación.',
);
console.log(
  'Equivalencia: PASS en cada repetición. IDs:',
  expected.map((item) => item.id).join(', '),
);
console.log('Heap (ms):', heapTimes.map((ms) => ms.toFixed(3)).join(', '));
console.log('Sort (ms):', sortTimes.map((ms) => ms.toFixed(3)).join(', '));
console.log('Mediana heap:', heapMs.toFixed(3), 'ms');
console.log('Mediana sort:', sortMs.toFixed(3), 'ms');
console.log('Relación sort/heap:', (sortMs / heapMs).toFixed(2) + 'x');
console.log('Heap: O(n log k), memoria O(k); sort: O(n log n), copia O(n).');
console.log(
  'Medición sintética local: no predice el tiempo de escaneo ni de IA.',
);
