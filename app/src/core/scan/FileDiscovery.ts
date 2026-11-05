import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Queue } from '../structures/Queue';
import { Stack } from '../structures/Stack';

export interface DiscoveredFile {
  path: string;
}

export interface DiscoveryOptions {
  exclude?: readonly string[];
  strategy?: 'dfs' | 'bfs';
}

interface Frontier {
  push(value: string): void;
  pop(): string | undefined;
  get peakSize(): number;
}

function createFrontier(strategy: 'dfs' | 'bfs'): Frontier {
  if (strategy === 'bfs') {
    const queue = new Queue<string>();
    return {
      push: (value) => queue.enqueue(value),
      pop: () => queue.dequeue(),
      get peakSize() {
        return queue.peakSize;
      },
    };
  }
  const stack = new Stack<string>();
  return {
    push: (value) => stack.push(value),
    pop: () => stack.pop(),
    get peakSize() {
      return stack.peakSize;
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function isSkippable(error: unknown): boolean {
  return ['EACCES', 'EPERM', 'ENOENT', 'EBUSY'].includes(
    errorCode(error) ?? '',
  );
}

export class FileDiscovery {
  peakStackSize = 0;
  peakFrontier = 0;
  dirsVisited = 0;
  skippedLinks = 0;
  // Entradas que no se pudieron leer, por código de error (EACCES, EPERM, ENOENT, EBUSY).
  // Map motivo -> cantidad: registrar es O(1) promedio y nunca guarda rutas, solo conteos.
  // Invariante: la suma de los valores es skippedEntries. Si es mayor que 0, la carpeta
  // no se recorrió completa y no debe presentarse como analizada en su totalidad (AUD-10).
  private readonly skipped = new Map<string, number>();

  get skippedEntries(): number {
    let total = 0;
    for (const count of this.skipped.values()) total += count;
    return total;
  }

  get skippedByReason(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.skipped);
  }

  // Devuelve true si el error es una omisión esperable y la deja contada.
  private skip(error: unknown): boolean {
    if (!isSkippable(error)) return false;
    const code = errorCode(error) ?? 'UNKNOWN';
    this.skipped.set(code, (this.skipped.get(code) ?? 0) + 1);
    return true;
  }

  async *discover(
    root: string,
    options: DiscoveryOptions = {},
    signal?: AbortSignal,
  ): AsyncGenerator<DiscoveredFile> {
    this.peakStackSize = 0;
    this.peakFrontier = 0;
    this.dirsVisited = 0;
    this.skippedLinks = 0;
    this.skipped.clear();
    const strategy = options.strategy ?? 'dfs';
    const excluded = new Set(
      (options.exclude ?? []).map((name) => name.toLowerCase()),
    );
    const frontier = createFrontier(strategy);
    const visited = new Set<string>();

    if (signal?.aborted) return;
    let rootInfo;
    try {
      rootInfo = await lstat(root);
    } catch (error) {
      if (this.skip(error)) return;
      throw error;
    }
    if (rootInfo.isSymbolicLink()) {
      this.skippedLinks += 1;
      return;
    }
    if (rootInfo.isFile()) {
      yield { path: root };
      return;
    }
    if (!rootInfo.isDirectory()) return;

    frontier.push(root);
    while (!signal?.aborted) {
      const folder = frontier.pop();
      if (folder === undefined) return;
      let key: string;
      try {
        key = (await realpath(folder)).toLowerCase();
      } catch (error) {
        if (this.skip(error)) continue;
        throw error;
      }
      if (visited.has(key)) continue;
      visited.add(key);
      this.dirsVisited += 1;

      let names: string[];
      try {
        names = await readdir(folder);
      } catch (error) {
        if (this.skip(error)) continue;
        throw error;
      }
      names.sort((left, right) => left.localeCompare(right, 'en'));

      const children: string[] = [];
      for (const name of names) {
        if (signal?.aborted) return;
        if (excluded.has(name.toLowerCase())) continue;
        const child = join(folder, name);
        let info;
        try {
          info = await lstat(child);
        } catch (error) {
          if (this.skip(error)) continue;
          throw error;
        }
        if (info.isSymbolicLink()) {
          this.skippedLinks += 1;
          continue;
        }
        if (info.isDirectory()) children.push(child);
        else if (info.isFile()) yield { path: child };
      }

      const ordered = strategy === 'bfs' ? children : [...children].reverse();
      for (const child of ordered) frontier.push(child);
      this.peakFrontier = frontier.peakSize;
      if (strategy === 'dfs') this.peakStackSize = frontier.peakSize;
    }
  }
}
