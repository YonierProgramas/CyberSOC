import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const count = Number(process.argv[2] ?? 5_000);
if (!Number.isSafeInteger(count) || count < 1 || process.argv.length > 3) {
  throw new Error(
    'Uso: npm run perf:scan -- [N entero positivo; por defecto 5000]',
  );
}
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const appUrl = pathToFileURL(appRoot).href;
// Execute the existing TypeScript core (including parameter properties and extensionless
// imports) using the installed compiler, without adding a runner dependency or editing core.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !extname(specifier) &&
      context.parentURL?.startsWith(appUrl)
    ) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate)))
        return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(appUrl) && url.endsWith('.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
          fileName: fileURLToPath(url),
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});

const { realRuntime } = await import('../tests/integration/real-runtime.ts');
const directory = mkdtempSync(join(tmpdir(), 'cybersoc-perf-scan-'));
const fixtures = join(directory, 'archivos');
let runtime: ReturnType<typeof realRuntime> | undefined;
try {
  const preparing = performance.now();
  for (let index = 0; index < count; index++) {
    const group = join(fixtures, `grupo-${Math.floor(index / 100)}`);
    if (index % 100 === 0) mkdirSync(group, { recursive: true });
    writeFileSync(
      join(group, `archivo-${String(index).padStart(6, '0')}.txt`),
      `Documento benigno de rendimiento ${index}.\n`,
      'utf8',
    );
  }
  const preparationMs = performance.now() - preparing;
  runtime = realRuntime(
    resolve(appRoot, '..', 'engine'),
    join(directory, 'cybersoc.db'),
  );
  await runtime.connect();
  console.log(`CyberSOC Defender — perf-scan con motor Python real`);
  console.log(
    `Plataforma: ${process.platform} ${process.arch}; Node: ${process.version}`,
  );
  console.log(
    `Archivos generados: ${count}; preparación: ${preparationMs.toFixed(2)} ms`,
  );
  console.log(
    `Motor: ${runtime.engine.getState().engineVersion}; protocolo: 1`,
  );
  let lastReported = 0;
  runtime.orchestrator.on('progress', (progress) => {
    if (progress.processed >= lastReported + 1_000) {
      lastReported = progress.processed;
      console.log(`Progreso: ${progress.processed}/${count}`);
    }
  });
  const started = performance.now();
  const job = await runtime.scan(fixtures, 600_000);
  const elapsed = performance.now() - started;
  assert.equal(
    job.status,
    'COMPLETED',
    job.errorMessage ?? runtime.logs.join('\n'),
  );
  assert.equal(job.filesProcessed, count);
  assert.equal(job.filesError, 0);
  assert.equal(job.filesSkipped, 0);
  const rows = runtime.database
    .prepare(
      "SELECT COUNT(*) AS total FROM scan_results WHERE job_id = ? AND status = 'SCANNED' AND verdict = 'NOT_EVALUATED'",
    )
    .get(job.id)!;
  assert.equal(Number(rows.total), count);
  const metrics = JSON.parse(job.metricsJson!) as Record<string, number>;
  console.log(
    `Estado: ${job.status}; filas SQLite: ${rows.total}; errores: ${job.filesError}; omitidos: ${job.filesSkipped}`,
  );
  console.log(`Tiempo de escaneo (start → finished): ${elapsed.toFixed(2)} ms`);
  console.log(
    `Archivos por segundo: ${(count / (elapsed / 1_000)).toFixed(2)}`,
  );
  console.log(`Pico de pila: ${metrics.peakStackSize}`);
  console.log(`Pico de cola: ${metrics.peakQueueSize}`);
  console.log(
    `Tiempo del productor bloqueado: ${metrics.producerBlockedMs!.toFixed(2)} ms`,
  );
  console.log(
    `Fase de descubrimiento: ${metrics.discoveryDurationMs!.toFixed(2)} ms`,
  );
  console.log(`Fase de consumo: ${metrics.scanningDurationMs!.toFixed(2)} ms`);
  console.log(
    'La medición excluye generación, arranque de Python, compilación y limpieza. Las fases se solapan.',
  );
} finally {
  try {
    await runtime?.close();
  } finally {
    hooks.deregister();
    const owned = resolve(directory);
    assert.ok(
      owned.startsWith(resolve(tmpdir()) + sep) &&
        owned.includes('cybersoc-perf-scan-'),
    );
    rmSync(owned, { recursive: true, force: true });
  }
}
