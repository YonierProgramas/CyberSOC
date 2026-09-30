import { Queue } from '../src/core/structures/Queue.ts';

const operations = Number(process.argv[2] ?? 1_000_000);

function measure(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

function queueRound(): void {
  const queue = new Queue<number>();
  for (let value = 0; value < operations; value += 1) queue.enqueue(value);
  for (let value = 0; value < operations; value += 1) queue.dequeue();
}

function arrayShiftRound(): void {
  const values: number[] = [];
  for (let value = 0; value < operations; value += 1) values.push(value);
  for (let value = 0; value < operations; value += 1) values.shift();
}

const queueMs = measure(queueRound);
const arrayMs = measure(arrayShiftRound);

console.log(
  `operaciones: ${operations} enqueue/push + ${operations} dequeue/shift`,
);
console.log(`Queue circular: ${queueMs.toFixed(1)} ms`);
console.log(`Array.shift:   ${arrayMs.toFixed(1)} ms`);
