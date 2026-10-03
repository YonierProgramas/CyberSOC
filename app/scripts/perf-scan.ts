import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { registerHooks } from 'node:module';
import { cpus, totalmem, tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const smallFiles = 10_000;
const gigabyte = 1024 * 1024 * 1024;
const treeWidth = 200;
const treeDepth = 40;
const filesPerWideDir = 6;
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const appUrl = pathToFileURL(appRoot).href;
const engineRoot = resolve(appRoot, '..', 'engine');

const requested = process.argv[2];
const legacyCount = requested === undefined ? null : Number(requested);
if (
  process.argv.length > 3 ||
  (legacyCount !== null &&
    (!Number.isSafeInteger(legacyCount) || legacyCount < 1))
) {
  throw new Error(
    'Uso: npm run perf:scan  (las cuatro mediciones)  o  npm run perf:scan -- N',
  );
}

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
type Runtime = ReturnType<typeof realRuntime>;

interface Metrics {
  peakStackSize: number;
  peakQueueSize: number;
  producerBlockedMs: number;
  discoveryDurationMs: number;
  scanningDurationMs: number;
  dirsVisited: number;
}

function ownedTemp(directory: string, marker: string): string {
  const owned = resolve(directory);
  assert.ok(
    owned.startsWith(resolve(tmpdir()) + sep) && owned.includes(marker),
  );
  return owned;
}

function removeTemp(directory: string, marker: string): void {
  rmSync(ownedTemp(directory, marker), { recursive: true, force: true });
}

function metricsOf(metricsJson: string | null): Metrics {
  const value: unknown = JSON.parse(metricsJson ?? '{}');
  assert.ok(value && typeof value === 'object');
  const record = value as Record<string, unknown>;
  const numberOf = (key: string) => {
    const item = record[key];
    assert.equal(typeof item, 'number', key);
    return item as number;
  };
  return {
    peakStackSize: numberOf('peakStackSize'),
    peakQueueSize: numberOf('peakQueueSize'),
    producerBlockedMs: numberOf('producerBlockedMs'),
    discoveryDurationMs: numberOf('discoveryDurationMs'),
    scanningDurationMs: numberOf('scanningDurationMs'),
    dirsVisited: numberOf('dirsVisited'),
  };
}

async function openRuntime(databasePath: string): Promise<Runtime> {
  const runtime = realRuntime(engineRoot, databasePath);
  await runtime.connect();
  return runtime;
}

interface FinishedJob {
  id: string;
  status: string;
  errorMessage: string | null;
  filesProcessed: number;
  filesError: number;
  filesSkipped: number;
  bytesProcessed: number;
  metricsJson: string | null;
}

function scanFolder(
  runtime: Runtime,
  folder: string,
  deadlineMs: number,
  profile?: {
    layers: Array<'HASH' | 'SIGNATURES'>;
    includeHidden: boolean;
    maxFileSizeMB: number;
  },
  onProgress?: (processed: number) => void,
): Promise<FinishedJob> {
  return new Promise((resolve, reject) => {
    let id = '';
    const finish = (job: FinishedJob) => {
      if (job.id !== id) return;
      clearTimeout(timer);
      runtime.orchestrator.off('finished', finish);
      runtime.orchestrator.off('progress', progress);
      resolve(job);
    };
    const progress = (update: { processed: number }) => {
      onProgress?.(update.processed);
    };
    const timer = setTimeout(() => {
      runtime.orchestrator.off('finished', finish);
      runtime.orchestrator.off('progress', progress);
      reject(
        new Error(
          `El escaneo superó ${deadlineMs} ms. ${runtime.logs.join('\n')}`,
        ),
      );
    }, deadlineMs);
    runtime.orchestrator.on('finished', finish);
    runtime.orchestrator.on('progress', progress);
    try {
      id = runtime.orchestrator.start({
        kind: 'FOLDER',
        path: folder,
        profile,
      });
    } catch (error) {
      clearTimeout(timer);
      runtime.orchestrator.off('finished', finish);
      runtime.orchestrator.off('progress', progress);
      reject(error);
    }
  });
}

function writeSmallFiles(folder: string, count: number): number {
  const preparing = performance.now();
  for (let index = 0; index < count; index += 1) {
    const group = join(folder, `grupo-${Math.floor(index / 100)}`);
    if (index % 100 === 0) mkdirSync(group, { recursive: true });
    writeFileSync(
      join(group, `archivo-${String(index).padStart(6, '0')}.txt`),
      `Documento benigno de rendimiento ${index}.\n`,
      'utf8',
    );
  }
  return performance.now() - preparing;
}

/** Escribe N bytes en bloques de 8 MiB. No retiene el archivo en RAM. */
function writeBytes(path: string, total: number): void {
  const fd = openSync(path, 'w');
  const chunk = Buffer.alloc(8 * 1024 * 1024, 0x61);
  try {
    let left = total;
    while (left > 0) {
      const size = Math.min(chunk.length, left);
      writeSync(fd, chunk, 0, size);
      left -= size;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * La pila del descubrimiento es DFS: push y pop son O(1) amortizado.
 * Invariante: el pico es el máximo de carpetas hermanas pendientes.
 * La cola de archivos está acotada (capacidad 1000): encolar y sacar son
 * O(1) amortizado; si se llena, el productor espera y no crece sin límite.
 */
function writeDeepWideTree(folder: string): { files: number; dirs: number } {
  mkdirSync(folder);
  for (let index = 0; index < treeWidth; index += 1) {
    const wide = join(folder, `ancho-${String(index).padStart(3, '0')}`);
    mkdirSync(wide);
    for (let file = 0; file < filesPerWideDir; file += 1) {
      writeFileSync(
        join(wide, `nota-${file}.txt`),
        `Texto inofensivo ${index}-${file}.\n`,
        'utf8',
      );
    }
  }
  let deep = join(folder, 'profundo');
  for (let level = 0; level < treeDepth; level += 1) {
    mkdirSync(deep);
    writeFileSync(join(deep, 'nota.txt'), `Nivel ${level}.\n`, 'utf8');
    deep = join(deep, 'd');
  }
  return {
    files: treeWidth * filesPerWideDir + treeDepth,
    dirs: 1 + treeWidth + treeDepth,
  };
}

function watchPythonMemory(parentPid: number): {
  maximum: () => number;
  samples: () => number;
  stop: () => void;
} {
  const command = `
    $parent = ${parentPid}
    while ($true) {
      $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe'")
      $ids = New-Object System.Collections.Generic.List[int]
      foreach ($proc in $procs) {
        $line = [string]$proc.CommandLine
        if ($proc.ParentProcessId -eq $parent -or $line.Contains('cybersoc_engine')) {
          $ids.Add([int]$proc.ProcessId)
        }
      }
      foreach ($proc in $procs) {
        if ($ids.Contains([int]$proc.ParentProcessId)) {
          $ids.Add([int]$proc.ProcessId)
        }
      }
      $max = [int64]0
      foreach ($id in $ids) {
        $live = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($live -and $live.WorkingSet64 -gt $max) { $max = $live.WorkingSet64 }
      }
      if ($max -gt 0) { Write-Output $max }
      Start-Sleep -Milliseconds 250
    }
  `;
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let maxBytes = 0;
  let count = 0;
  let pending = '';
  child.stdout.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const value = Number(line.trim());
      if (!Number.isFinite(value) || value <= 0) continue;
      count += 1;
      if (value > maxBytes) maxBytes = value;
    }
  });
  return {
    maximum: () => maxBytes,
    samples: () => count,
    stop: () => child.kill(),
  };
}

async function readProcess(child: ReturnType<typeof spawn>): Promise<string> {
  let text = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`No se pudo leer el disco (código ${code}).`);
  return text.trim();
}

async function scenarioSmall(count: number): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'cybersoc-perf-scan-'));
  const folder = join(directory, 'archivos');
  let runtime: Runtime | undefined;
  try {
    const preparationMs = writeSmallFiles(folder, count);
    runtime = await openRuntime(join(directory, 'cybersoc.db'));
    console.log('CyberSOC Defender — perf-scan con motor Python real');
    console.log(
      `Plataforma: ${process.platform} ${process.arch}; Node: ${process.version}`,
    );
    console.log(
      `Motor: ${runtime.engine.getState().engineVersion}; protocolo: 1`,
    );
    console.log(
      `(a) Archivos generados: ${count}; preparación: ${preparationMs.toFixed(2)} ms`,
    );
    let lastReported = 0;
    const started = performance.now();
    const job = await scanFolder(
      runtime,
      folder,
      600_000,
      undefined,
      (processed) => {
        if (processed >= lastReported + 1_000) {
          lastReported = processed;
          console.log(`Progreso: ${processed}/${count}`);
        }
      },
    );
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
        `SELECT verdict, COUNT(*) AS total FROM scan_results
         WHERE job_id = ? AND status = 'SCANNED' GROUP BY verdict`,
      )
      .all(job.id) as Array<{ verdict: string; total: number }>;
    const scanned = rows.reduce((sum, row) => sum + Number(row.total), 0);
    assert.equal(scanned, count);
    const metrics = metricsOf(job.metricsJson);
    console.log(
      `(a) Duración total: ${elapsed.toFixed(2)} ms; archivos/s: ${(count / (elapsed / 1_000)).toFixed(2)}`,
    );
    console.log(
      `(a) Veredictos: ${rows.map((row) => `${row.verdict}=${row.total}`).join(', ')}`,
    );
    console.log(
      `(a) Pico de pila: ${metrics.peakStackSize}; pico de cola: ${metrics.peakQueueSize}`,
    );
  } finally {
    await runtime?.close();
    removeTemp(directory, 'cybersoc-perf-scan-');
  }
}

async function scenarioGigabyte(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'cybersoc-perf-gb-'));
  const folder = join(directory, 'grande');
  mkdirSync(folder);
  const file = join(folder, 'muestra-1gib.bin');
  let runtime: Runtime | undefined;
  const watcher = watchPythonMemory(process.pid);
  try {
    const preparing = performance.now();
    writeBytes(file, gigabyte);
    console.log(
      `(b) Archivo generado: ${gigabyte} bytes en ${(performance.now() - preparing).toFixed(2)} ms`,
    );
    runtime = await openRuntime(join(directory, 'cybersoc.db'));
    const started = performance.now();
    const job = await scanFolder(runtime, folder, 1_200_000, {
      layers: ['HASH', 'SIGNATURES'],
      includeHidden: false,
      maxFileSizeMB: 2048,
    });
    const elapsed = performance.now() - started;
    assert.equal(
      job.status,
      'COMPLETED',
      job.errorMessage ?? runtime.logs.join('\n'),
    );
    assert.equal(job.filesProcessed, 1);
    assert.equal(job.filesSkipped, 0);
    assert.equal(job.bytesProcessed, gigabyte);
    const row = runtime.database
      .prepare(
        `SELECT status, verdict, size_bytes AS sizeBytes FROM scan_results WHERE job_id = ?`,
      )
      .get(job.id) as { status: string; verdict: string; sizeBytes: number };
    assert.equal(row.status, 'SCANNED');
    assert.equal(Number(row.sizeBytes), gigabyte);
    const mebibytes = gigabyte / (1024 * 1024);
    const memoryMb = watcher.maximum() / (1024 * 1024);
    assert.ok(watcher.samples() > 0, 'No se muestreó la memoria de Python.');
    assert.ok(
      watcher.maximum() < gigabyte,
      `La memoria de Python llegó a ${memoryMb.toFixed(1)} MiB, por encima del archivo.`,
    );
    console.log(
      `(b) Duración: ${elapsed.toFixed(2)} ms; MB/s: ${(mebibytes / (elapsed / 1_000)).toFixed(2)}; veredicto: ${row.verdict}`,
    );
    console.log(
      `(b) Memoria máxima del proceso Python: ${memoryMb.toFixed(1)} MiB en ${watcher.samples()} muestras`,
    );
    console.log(
      '(b) El perfil de esta medición permite 2048 MB. El perfil de zona, en uso normal, omite archivos más grandes.',
    );
  } finally {
    watcher.stop();
    await runtime?.close();
    removeTemp(directory, 'cybersoc-perf-gb-');
  }
}

async function scenarioTree(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'cybersoc-perf-tree-'));
  const folder = join(directory, 'arbol');
  let runtime: Runtime | undefined;
  try {
    const shape = writeDeepWideTree(folder);
    runtime = await openRuntime(join(directory, 'cybersoc.db'));
    const job = await scanFolder(runtime, folder, 180_000);
    assert.equal(
      job.status,
      'COMPLETED',
      job.errorMessage ?? runtime.logs.join('\n'),
    );
    assert.equal(job.filesProcessed, shape.files);
    assert.equal(job.filesError, 0);
    const metrics = metricsOf(job.metricsJson);
    assert.ok(metrics.peakStackSize >= treeWidth);
    assert.ok(metrics.peakQueueSize >= 1);
    assert.ok(metrics.peakQueueSize <= 1_000);
    console.log(
      `(c) Árbol: anchura ${treeWidth}, profundidad ${treeDepth}, archivos ${shape.files}, carpetas ${shape.dirs}`,
    );
    console.log(
      `(c) Pico de pila: ${metrics.peakStackSize}; pico de cola: ${metrics.peakQueueSize}; carpetas visitadas: ${metrics.dirsVisited}`,
    );
    console.log(
      `(c) Productor bloqueado: ${metrics.producerBlockedMs.toFixed(2)} ms`,
    );
  } finally {
    await runtime?.close();
    removeTemp(directory, 'cybersoc-perf-tree-');
  }
}

async function scenarioUi(): Promise<void> {
  const scriptPath = join(appRoot, 'scripts', '.ui-measure.mjs');
  writeFileSync(scriptPath, uiMeasureSource(), 'utf8');
  try {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: appRoot,
      stdio: 'inherit',
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (code !== 0)
      throw new Error(`La medición de la UI terminó con código ${code}.`);
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

function uiMeasureSource(): string {
  return "import assert from 'node:assert/strict';\nimport { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join, resolve, sep } from 'node:path';\nimport { _electron as electron } from 'playwright';\n\nconst appRoot = process.cwd();\nconst evidence = mkdtempSync(join(tmpdir(), 'cybersoc-evidence-'));\nconst folder = join(evidence, 'pausa');\nmkdirSync(folder);\nfor (let index = 0; index < 800; index += 1) {\n  writeFileSync(\n    join(folder, `nota-${String(index).padStart(3, '0')}.txt`),\n    `Texto inofensivo ${index}\\n`,\n    'utf8',\n  );\n}\nconst env = { ...process.env };\ndelete env.ELECTRON_RUN_AS_NODE;\ndelete env.ELECTRON_RENDERER_URL;\ndelete env.CYBERSOC_ANTHROPIC_API_KEY;\ndelete env.CYBERSOC_ENGINE_CMD;\ndelete env.NODE_OPTIONS;\nenv.CYBERSOC_EVIDENCE_MODE = '1';\nenv.CYBERSOC_EVIDENCE_LIVE = '0';\nenv.CYBERSOC_EVIDENCE_ROOT = evidence;\nenv.PYTHONPATH = join(appRoot, '..', 'engine', 'src');\nconst app = await electron.launch({\n  args: [appRoot],\n  cwd: appRoot,\n  timeout: 30_000,\n  env,\n});\ntry {\n  const page = await app.firstWindow();\n  page.setDefaultTimeout(20_000);\n  await page.getByTestId('nav-status').click();\n  const deadline = Date.now() + 60_000;\n  let disconnectedSince = 0;\n  let reconnects = 0;\n  while (Date.now() < deadline) {\n    const text = await page.getByTestId('engine-status').innerText();\n    if (text.includes('Motor: conectado')) break;\n    if (text.includes('desconectado')) {\n      if (disconnectedSince === 0) disconnectedSince = Date.now();\n      const button = page.getByRole('button', { name: 'Reconectar' });\n      if (\n        Date.now() - disconnectedSince > 8_000 &&\n        reconnects < 2 &&\n        (await button.isEnabled())\n      ) {\n        reconnects += 1;\n        disconnectedSince = 0;\n        await button.click();\n      }\n    } else {\n      disconnectedSince = 0;\n    }\n    await page.waitForTimeout(200);\n  }\n  const status = await page.getByTestId('engine-status').innerText();\n  if (!status.includes('Motor: conectado')) {\n    throw new Error(`El motor no se conectó para medir la UI. Estado: ${status}`);\n  }\n  await app.evaluate((_electron, target) => {\n    process.env.CYBERSOC_EVIDENCE_DIALOG_PATH = target;\n    process.env.CYBERSOC_EVIDENCE_SCAN_DELAY_MS = '40';\n  }, folder);\n  await page.getByTestId('nav-scan').click();\n  await page.getByTestId('scan-folder').click();\n  await page.getByTestId('job-status').filter({ hasText: 'Analizando' }).waitFor({\n    timeout: 20_000,\n  });\n  const samples = [];\n  for (const testId of ['nav-status', 'nav-scan', 'nav-history', 'nav-scan']) {\n    const started = performance.now();\n    await page.getByTestId(testId).click();\n    await page.waitForFunction(\n      (id) =>\n        document\n          .querySelector(`[data-testid=\"${id}\"]`)\n          ?.getAttribute('aria-current') === 'page',\n      testId,\n    );\n    samples.push(performance.now() - started);\n  }\n  const worst = Math.max(...samples);\n  console.log(\n    `(d) Respuesta de clic durante el escaneo (ms): ${samples.map((item) => item.toFixed(1)).join(', ')}`,\n  );\n  console.log(`(d) Peor clic: ${worst.toFixed(1)} ms`);\n  assert.ok(worst < 2_000, `Un clic tardó ${worst.toFixed(0)} ms.`);\n} finally {\n  await app.close();\n  const owned = resolve(evidence);\n  assert.ok(\n    owned.startsWith(resolve(tmpdir()) + sep) &&\n      owned.includes('cybersoc-evidence-'),\n  );\n  rmSync(owned, { recursive: true, force: true });\n}\n";
}
try {
  console.log(await machineBanner());
  if (legacyCount !== null) await scenarioSmall(legacyCount);
  else {
    await scenarioSmall(smallFiles);
    await scenarioGigabyte();
    await scenarioTree();
    await scenarioUi();
  }
  console.log(
    'La medición de archivos excluye generación, arranque de Python y limpieza.',
  );
} finally {
  hooks.deregister();
}

async function machineBanner(): Promise<string> {
  const cpu = cpus()[0]?.model?.trim() || 'CPU no identificada';
  const drive = tmpdir().slice(0, 2);
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$drive='${drive}'; $volume=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'"; $disks=(Get-PhysicalDisk | ForEach-Object { $_.FriendlyName.Trim() + ' ' + [string]$_.MediaType }) -join '; '; Write-Output ($disks + '|' + $volume.Size + '|' + $volume.FreeSpace)`,
    ],
    { windowsHide: true },
  );
  const disk = await readProcess(child);
  const [disks, size, free] = disk.split('|');
  const gib = (value: string) => (Number(value) / 1024 ** 3).toFixed(1);
  return [
    'Máquina',
    `CPU: ${cpu} (${cpus().length} hilos lógicos)`,
    `RAM: ${(totalmem() / 1024 ** 3).toFixed(1)} GB`,
    `Discos: ${disks}; volumen ${drive} ${gib(size ?? '0')} GB, libres ${gib(free ?? '0')} GB`,
  ].join('\n');
}
