import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sha256 = (data: Buffer) =>
  createHash('sha256').update(data).digest('hex');

/** Expected digest compiled inside the ASAR; EXE/fuses verify that ASAR.
 * It does not authenticate a joint EXE replacement without a trusted signature/publisher.
 */
export function verifyResources(resources: string, expected: string): void {
  if (!/^[a-f0-9]{64}$/.test(expected))
    throw new Error('Falta digest de recursos en release.');
  const manifest = readFileSync(join(resources, 'resources-manifest.json'));
  if (sha256(manifest) !== expected)
    throw new Error('Manifiesto de recursos alterado.');
  const entries: unknown = JSON.parse(
    manifest.toString('utf8').replace(/^\uFEFF/, ''),
  );
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error('Manifiesto vacío.');
  // Invariant: one unique path per file. Set.add/has/delete O(1) average;
  // traversal O(n), O(n) memory. Each file found is removed only once.
  const remaining = new Set<string>();
  for (const entry of entries as {
    path: string;
    size: number;
    sha256: string;
  }[]) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !/^(runtime|engine|notices)\/[\w./ -]+$/.test(entry.path) ||
      entry.path
        .split('/')
        .some((part) => part === '..' || part === '.' || part === '') ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      remaining.has(entry.path)
    ) {
      throw new Error('Ruta/entrada de recursos inválida.');
    }
    remaining.add(entry.path);
    const path = join(resources, entry.path);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== entry.size ||
      sha256(readFileSync(path)) !== entry.sha256
    ) {
      throw new Error('Recurso alterado o ausente.');
    }
  }
  const walk = (relative: string) => {
    const path = join(resources, relative);
    if (
      lstatSync(path).isSymbolicLink() ||
      realpathSync(path).toLowerCase() !== resolve(path).toLowerCase()
    )
      throw new Error('Recursos enlazados.');
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const child = `${relative}/${item.name}`;
      if (item.isSymbolicLink()) throw new Error('Recurso enlazado.');
      if (item.isDirectory()) walk(child);
      else if (!item.isFile() || !remaining.delete(child))
        throw new Error('Recurso adicional no autorizado.');
    }
  };
  for (const directory of ['runtime', 'engine', 'notices']) walk(directory);
  if (remaining.size !== 0)
    throw new Error('Inventario de recursos incompleto.');
}
