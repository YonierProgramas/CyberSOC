import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { win32 } from 'node:path';
import { PathTrie } from '../src/core/structures/PathTrie.ts';

const classifications = 100_000;
const repetitions = 3;
const prefixes = [
  'C:\\',
  'C:\\Users\\Estudiante\\AppData\\Local',
  'C:\\Users\\Estudiante\\AppData\\Local\\Temp',
  ...Array.from({ length: 256 }, (_, i) => 'C:\\Datos\\Zona' + i),
];
const trie = new PathTrie<number>();
prefixes.forEach((prefix, i) => trie.insert(prefix, i + 1));

// Alternativa lineal: el primer prefijo válido de la lista ordenada por longitud
// es el más específico. Preparar p prefijos cuesta O(p log p) comparaciones;
// consultar cuesta O(p * L) en el peor caso (L caracteres de comparación).
const ordered = prefixes
  .map((prefix, i) => {
    const normalized = win32.normalize(prefix).toLowerCase();
    return {
      prefix: normalized,
      boundary: normalized.endsWith('\\') ? normalized : normalized + '\\',
      value: i + 1,
    };
  })
  .sort((a, b) => b.prefix.length - a.prefix.length);

function listMatch(path: string): number | undefined {
  const normalized = win32.normalize(path.replaceAll('/', '\\')).toLowerCase();
  return ordered.find(
    ({ prefix, boundary }) =>
      normalized === prefix || normalized.startsWith(boundary),
  )?.value;
}

// Corpus determinista: zonas hermanas, anidamiento, coincidencias parciales,
// otra unidad y variantes de escritura. No se lee ni escribe ningún fixture.
const paths = Array.from({ length: classifications }, (_, i) => {
  const zone = i % 256;
  switch (i % 5) {
    case 0:
      return 'C:/DATOS/Zona' + zone + '/archivo-' + i + '.txt';
    case 1:
      return 'c:\\Users\\Estudiante\\AppData\\Local\\Temp\\archivo-' + i;
    case 2:
      return 'C:\\Users\\Estudiante\\AppData\\Local\\Editor\\archivo-' + i;
    case 3:
      return 'C:\\Datos\\Zona' + zone + '-otra\\archivo-' + i;
    default:
      return 'D:\\SinZona\\archivo-' + i;
  }
});

let expectedChecksum = 0;
// Antes de medir, comprobamos cada resultado, no solo la suma de resultados.
for (const path of paths) {
  const value = listMatch(path);
  assert.equal(trie.longestPrefixMatch(path), value, path);
  expectedChecksum += value ?? 0;
}

type Classifier = (path: string) => number | undefined;
const trieMatch: Classifier = (path) => trie.longestPrefixMatch(path);

function measure(classify: Classifier): number {
  const start = performance.now();
  let checksum = 0;
  for (const path of paths) checksum += classify(path) ?? 0;
  const elapsed = performance.now() - start;
  assert.equal(checksum, expectedChecksum);
  return elapsed;
}

// Calentamiento equivalente y orden alternado para reducir el sesgo del JIT.
for (const path of paths.slice(0, 5_000)) {
  trieMatch(path);
  listMatch(path);
}
const trieTimes: number[] = [];
const listTimes: number[] = [];
for (let round = 0; round < repetitions; round++) {
  if (round % 2 === 0) {
    trieTimes.push(measure(trieMatch));
    listTimes.push(measure(listMatch));
  } else {
    listTimes.push(measure(listMatch));
    trieTimes.push(measure(trieMatch));
  }
}
function median(times: number[]): number {
  return [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
}
const trieMs = median(trieTimes);
const listMs = median(listTimes);

console.log('CyberSOC — PathTrie frente a lista de prefijos');
console.log('Fecha UTC:', new Date().toISOString());
console.log('Entorno:', process.platform, process.arch, process.version);
console.log('CPU:', cpus()[0]?.model ?? 'desconocida');
console.log('Prefijos:', prefixes.length);
console.log('Clasificaciones por repetición y algoritmo:', classifications);
console.log('Repeticiones:', repetitions, '(mediana; orden alternado)');
console.log(
  'Normalización incluida; construcción, corpus y validación excluidos.',
);
console.log('Equivalencia: PASS, 100000 resultados idénticos.');
console.log('Checksum:', expectedChecksum);
console.log('PathTrie (ms):', trieTimes.map((ms) => ms.toFixed(3)).join(', '));
console.log('Lista (ms):', listTimes.map((ms) => ms.toFixed(3)).join(', '));
console.log('Mediana PathTrie:', trieMs.toFixed(3), 'ms');
console.log('Mediana lista:', listMs.toFixed(3), 'ms');
console.log('Relación lista/Trie:', (listMs / trieMs).toFixed(2) + 'x');
console.log('Medición sintética; no garantiza una ventaja con pocas zonas.');
