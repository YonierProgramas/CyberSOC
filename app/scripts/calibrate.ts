// Calibración con corpus benigno (plan S3, T3.11).
// Uso: npm run calibrate -- [ruta ...]
//   Por defecto: C:\Windows\System32 y C:\Program Files, un escaneo por ruta.
// Escanea en SOLO LECTURA con el orquestador real de main, el perfil AUTO y la IA real
// (tope de 50 análisis automáticos por escaneo). Requiere CYBERSOC_ANTHROPIC_API_KEY.
// La base SQLite es temporal y se borra al terminar; el motor nunca escribe archivos.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// composition-root importa electron (app.getPath para las zonas, dialog, safeStorage). Fuera
// de Electron se sustituye por un módulo mínimo, igual que hacen las pruebas con vi.mock:
// getPath devuelve las carpetas del usuario actual; nada más se usa en este script.
const electronStub = `
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
const home = process.env.USERPROFILE ?? homedir();
const paths = {
  downloads: join(home, 'Downloads'),
  desktop: join(home, 'Desktop'),
  documents: join(home, 'Documents'),
  temp: tmpdir(),
  appData: process.env.APPDATA ?? join(home, 'AppData', 'Roaming'),
};
export const app = {
  isPackaged: false,
  getPath(name) {
    if (!(name in paths)) throw new Error('getPath no disponible en calibrate: ' + name);
    return paths[name];
  },
};
export const dialog = {};
export const safeStorage = {};
export default { app, dialog, safeStorage };
`;
const stubUrl = `data:text/javascript,${encodeURIComponent(electronStub)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron')
      return { url: stubUrl, format: 'module', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { createAIWorkflow, createScanOrchestrator } =
  await import('../src/main/composition-root');
const { Database } = await import('../src/core/persistence/Database');
const { MigrationRunner } =
  await import('../src/core/persistence/MigrationRunner');
const { AppConfigStore } = await import('../src/core/config/AppConfig');
const { EngineProcess } = await import('../src/core/engine/EngineProcess');
const { ClaudeProvider } =
  await import('../src/core/ai/providers/ClaudeProvider');

/** Precio de Haiku 4.5 por millón de tokens (USD), para estimar el coste. */
const PRICE = { input: 1, output: 5 };
const DEFAULT_PATHS = ['C:\\Windows\\System32', 'C:\\Program Files'];
const AI_DRAIN_TIMEOUT_MS = 30 * 60_000;

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : DEFAULT_PATHS;
for (const path of targets) {
  if (!existsSync(path)) throw new Error(`No existe la ruta: ${path}`);
}
const apiKey = process.env.CYBERSOC_ANTHROPIC_API_KEY?.trim();
if (!apiKey)
  throw new Error(
    'Falta CYBERSOC_ANTHROPIC_API_KEY: la calibración mide los escalamientos con la API real.',
  );

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const engineRoot = resolve(appRoot, '..', 'engine');
const python = join(engineRoot, '.venv', 'Scripts', 'python.exe');
const directory = mkdtempSync(join(tmpdir(), 'cybersoc-calibracion-'));
const db = new Database(join(directory, 'calibracion.db'));
new MigrationRunner(db).run();
const config = new AppConfigStore(db).load();
assert.equal(
  config.ai.autoAnalyzeLimitPerScan,
  50,
  'La calibración usa el tope por defecto de 50 análisis automáticos por escaneo.',
);

const engineErrors: string[] = [];
const engine = new EngineProcess({
  command: () => ({ file: python, args: ['-m', 'cybersoc_engine'] }),
  cwd: appRoot,
  logger: {
    info() {},
    error(message: string) {
      if (engineErrors.length < 20) engineErrors.push(message);
    },
  },
  spawnProcess: ((
    file: string,
    args: string[],
    options: Parameters<typeof spawn>[2],
  ) => {
    // El proceso Python no recibe la clave y usa el código de este repositorio.
    const env: NodeJS.ProcessEnv = {
      ...(options?.env ?? process.env),
      PYTHONPATH: join(engineRoot, 'src'),
      PYTHONDONTWRITEBYTECODE: '1',
    };
    delete env.CYBERSOC_ANTHROPIC_API_KEY;
    return spawn(file, args, { ...options, env, windowsHide: true });
  }) as typeof spawn,
});
const provider = new ClaudeProvider({
  apiKey,
  model: config.ai.analysisModel,
});
const worker = createAIWorkflow(db, () => provider);

const out: string[] = [];
const log = (line = '') => {
  out.push(line);
  console.log(line);
};
const rows = (sql: string, ...params: Array<string | number>) =>
  db.prepare(sql).all(...params);
const one = (sql: string, ...params: Array<string | number>) =>
  db.prepare(sql).get(...params)!;
const pct = (part: number, total: number) =>
  total ? `${((100 * part) / total).toFixed(3)} %` : '—';

function waitForAI(): Promise<void> {
  const started = Date.now();
  return new Promise((done, fail) => {
    const tick = () => {
      const state = worker.state;
      if (state.pending === 0) return done();
      if (state.paused)
        return fail(new Error('El worker de IA se pausó (credencial o red).'));
      if (Date.now() - started > AI_DRAIN_TIMEOUT_MS)
        return fail(new Error('La cola de IA no terminó a tiempo.'));
      setTimeout(tick, 1_000);
    };
    tick();
  });
}

function report(label: string, jobIds: string[]) {
  const where = `job_id IN (${jobIds.map(() => '?').join(', ')})`;
  const total = Number(
    one(`SELECT COUNT(*) AS n FROM scan_results WHERE ${where}`, ...jobIds).n,
  );
  const verdicts = Object.fromEntries(
    rows(
      `SELECT verdict, COUNT(*) AS n FROM scan_results WHERE ${where} GROUP BY verdict`,
      ...jobIds,
    ).map((r) => [String(r.verdict), Number(r.n)]),
  );
  const evaluated =
    (verdicts.CLEAN ?? 0) +
    (verdicts.SUSPICIOUS ?? 0) +
    (verdicts.DETECTED ?? 0);
  const escalations = Number(
    one(
      `SELECT COUNT(*) AS n FROM risk_assessments a JOIN scan_results r ON r.id = a.result_id
       WHERE r.${where} AND a.origin = 'AI_ESCALATION'`,
      ...jobIds,
    ).n,
  );
  const reviews = Number(
    one(
      `SELECT COUNT(*) AS n FROM risk_assessments a JOIN scan_results r ON r.id = a.result_id
       WHERE r.${where} AND a.review_required = 1`,
      ...jobIds,
    ).n,
  );

  log(`=== ${label} ===`);
  log(
    `Resultados: ${total}; evaluados (CLEAN/SUSPICIOUS/DETECTED): ${evaluated}`,
  );
  log('Por estado del archivo:');
  for (const r of rows(
    `SELECT status, COALESCE(error_code, '-') AS code, COUNT(*) AS n FROM scan_results
     WHERE ${where} GROUP BY status, code ORDER BY n DESC`,
    ...jobIds,
  ))
    log(`  ${r.status} ${r.code}: ${r.n}`);
  log('Por veredicto final:');
  for (const [verdict, n] of Object.entries(verdicts).sort())
    log(
      ['CLEAN', 'SUSPICIOUS', 'DETECTED'].includes(verdict)
        ? `  ${verdict}: ${n} (${pct(n, evaluated)} de los evaluados)`
        : `  ${verdict}: ${n} (${pct(n, total)} del total; no cuenta como evaluado)`,
    );
  log('Por veredicto del motor (antes de la IA):');
  for (const r of rows(
    `SELECT a.engine_verdict AS v, COUNT(*) AS n FROM risk_assessments a
     JOIN scan_results r ON r.id = a.result_id WHERE r.${where} GROUP BY v ORDER BY v`,
    ...jobIds,
  ))
    log(`  ${r.v}: ${r.n}`);
  log('Por zona:');
  for (const r of rows(
    `SELECT COALESCE(zone, '(sin zona)') AS zone, COUNT(*) AS n,
       SUM(verdict = 'SUSPICIOUS') AS s, SUM(verdict = 'DETECTED') AS d
     FROM scan_results WHERE ${where} GROUP BY zone ORDER BY n DESC`,
    ...jobIds,
  ))
    log(`  ${r.zone}: ${r.n} (SUSPICIOUS ${r.s}, DETECTED ${r.d})`);
  log('Capas por estado (efecto del perfil AUTO):');
  for (const r of rows(
    `SELECT l.layer, l.status, COUNT(*) AS n FROM result_layers l
     JOIN scan_results r ON r.id = l.result_id WHERE r.${where}
     GROUP BY l.layer, l.status ORDER BY l.layer, l.status`,
    ...jobIds,
  ))
    log(`  ${r.layer} ${r.status}: ${r.n}`);
  log('Por código de evidencia (apariciones / archivos):');
  const codes = rows(
    `SELECT e.source, e.code, e.severity, COUNT(*) AS n, COUNT(DISTINCT e.result_id) AS files
     FROM evidences e JOIN scan_results r ON r.id = e.result_id WHERE r.${where}
     GROUP BY e.source, e.code, e.severity ORDER BY n DESC`,
    ...jobIds,
  );
  if (!codes.length) log('  (ninguna evidencia)');
  for (const r of codes)
    log(`  ${r.source}/${r.code} [${r.severity}]: ${r.n} / ${r.files}`);
  log('Evidencias por código y extensión del archivo (máximo 25):');
  for (const r of rows(
    `SELECT e.code, COALESCE(lower(r.extension), '(sin extensión)') AS ext, COUNT(*) AS n
     FROM evidences e JOIN scan_results r ON r.id = e.result_id WHERE r.${where}
     GROUP BY e.code, ext ORDER BY n DESC LIMIT 25`,
    ...jobIds,
  ))
    log(`  ${r.code} ${r.ext}: ${r.n}`);

  log('IA (FILE_RESULT):');
  for (const r of rows(
    `SELECT validation_status AS s, COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i,
       COALESCE(SUM(output_tokens), 0) AS o FROM ai_analyses
     WHERE ${where} AND kind = 'FILE_RESULT' GROUP BY s ORDER BY s`,
    ...jobIds,
  ))
    log(`  ${r.s}: ${r.n} intentos (${r.i} tokens entrada, ${r.o} salida)`);
  for (const jobId of jobIds) {
    const analyzed = Number(
      one(
        `SELECT COUNT(DISTINCT result_id) AS n FROM ai_analyses WHERE job_id = ? AND kind = 'FILE_RESULT'`,
        jobId,
      ).n,
    );
    log(`  Escaneo ${jobId}: ${analyzed} resultados analizados (tope 50)`);
  }
  log('IA (JOB_SUMMARY):');
  for (const r of rows(
    `SELECT validation_status AS s, COUNT(*) AS n FROM ai_analyses
     WHERE ${where} AND kind = 'JOB_SUMMARY' GROUP BY s ORDER BY s`,
    ...jobIds,
  ))
    log(`  ${r.s}: ${r.n}`);
  const tokens = one(
    `SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o
     FROM ai_analyses WHERE ${where}`,
    ...jobIds,
  );
  const cost =
    (Number(tokens.i) * PRICE.input + Number(tokens.o) * PRICE.output) / 1e6;
  log(
    `  Tokens totales: ${tokens.i} entrada, ${tokens.o} salida; coste estimado ${cost.toFixed(4)} USD (Haiku 4.5: ${PRICE.input}/${PRICE.output} USD por millón)`,
  );
  log('Opinión de la IA en análisis válidos (vigente por resultado):');
  for (const r of rows(
    `SELECT a.ai_opinion AS opinion, COUNT(*) AS n, MIN(a.ai_confidence) AS lo,
       MAX(a.ai_confidence) AS hi, SUM(a.ai_confidence >= 0.7) AS high
     FROM risk_assessments a JOIN scan_results r ON r.id = a.result_id
     WHERE r.${where} AND a.ai_opinion IS NOT NULL GROUP BY opinion ORDER BY n DESC`,
    ...jobIds,
  ))
    log(
      `  ${r.opinion}: ${r.n} (confianza ${r.lo}–${r.hi}; con confianza ≥ 0.7: ${r.high})`,
    );
  log(`Escalamientos por IA (CLEAN → SUSPICIOUS): ${escalations}`);
  log(`Revisiones humanas pedidas: ${reviews}`);

  const listed = rows(
    `SELECT r.verdict, r.path, r.engine_score AS score, r.zone, COALESCE(a.origin, '-') AS origin,
       COALESCE(a.ai_opinion || ' ' || a.ai_confidence, '-') AS ai,
       COALESCE((SELECT group_concat(e.source || '/' || e.code, ', ') FROM evidences e
                 WHERE e.result_id = r.id), '') AS codes
     FROM scan_results r LEFT JOIN risk_assessments a ON a.result_id = r.id
     WHERE r.${where} AND r.verdict IN ('SUSPICIOUS', 'DETECTED')
     ORDER BY r.verdict DESC, r.engine_score DESC, r.path LIMIT 100`,
    ...jobIds,
  );
  log(`Resultados SUSPICIOUS/DETECTED (máximo 100): ${listed.length}`);
  for (const r of listed)
    log(
      `  ${r.verdict} ${r.score} ${r.zone ?? '-'} ${r.origin} IA=${r.ai} ${r.path} [${r.codes}]`,
    );

  const detected = verdicts.DETECTED ?? 0;
  const suspicious = verdicts.SUSPICIOUS ?? 0;
  const suspiciousRate = evaluated ? suspicious / evaluated : 0;
  log('Objetivos del plan:');
  log(`  0 DETECTED: ${detected === 0 ? 'CUMPLE' : 'NO CUMPLE'} (${detected})`);
  log(
    `  < 1 % SUSPICIOUS: ${suspiciousRate < 0.01 ? 'CUMPLE' : 'NO CUMPLE'} (${pct(suspicious, evaluated)})`,
  );
  log(
    `  0 escalamientos por IA: ${escalations === 0 ? 'CUMPLE' : 'NO CUMPLE'} (${escalations})`,
  );
  log();
}

const owned = resolve(directory);
try {
  const state = await engine.reconnect();
  if (state.status !== 'connected')
    throw new Error('No se conectó el motor Python.');
  log('CyberSOC Defender — calibración con corpus benigno (T3.11)');
  log(`Fecha UTC: ${new Date().toISOString()}`);
  log(
    `Plataforma: ${process.platform} ${process.arch}; Node: ${process.version}`,
  );
  log(`Motor: ${state.engineVersion}; modelo IA: ${config.ai.analysisModel}`);
  log('Perfil: AUTO (por zona); tope IA: 50 análisis automáticos por escaneo');
  log(`Rutas: ${targets.join(' · ')}`);
  log();

  worker.start();
  const jobIds: string[] = [];
  for (const path of targets) {
    const orchestrator = createScanOrchestrator(db, engine, worker);
    let next = 10_000;
    orchestrator.on('progress', (progress) => {
      if (progress.processed >= next) {
        next += 10_000;
        console.log(
          `  … ${path}: ${progress.processed} procesados (${new Date().toISOString()})`,
        );
      }
    });
    const finished = new Promise<{ id: string; status: string }>((done) =>
      orchestrator.once('finished', done),
    );
    const started = performance.now();
    const jobId = orchestrator.start({ kind: 'FOLDER', path, profile: 'AUTO' });
    const job = await finished;
    const seconds = (performance.now() - started) / 1_000;
    const record = one(
      `SELECT files_discovered AS d, files_processed AS p, files_error AS e,
         files_skipped AS s, bytes_processed AS b FROM scan_jobs WHERE id = ?`,
      jobId,
    );
    log(
      `Escaneo ${jobId} (${path}): ${job.status} en ${seconds.toFixed(1)} s; descubiertos ${record.d}, procesados ${record.p}, errores ${record.e}, omitidos ${record.s}, ${(Number(record.b) / 2 ** 30).toFixed(2)} GiB, ${(Number(record.p) / seconds).toFixed(1)} archivos/s`,
    );
    assert.equal(job.status, 'COMPLETED', `El escaneo de ${path} no terminó.`);
    jobIds.push(jobId);
  }
  console.log('  … esperando a que termine la cola de IA');
  const aiStarted = performance.now();
  await waitForAI();
  log(
    `Cola de IA terminada en ${((performance.now() - aiStarted) / 1_000).toFixed(1)} s después del último escaneo.`,
  );
  if (engineErrors.length)
    log(
      `Errores registrados por el motor (máx. 20): ${engineErrors.join(' | ')}`,
    );
  log();

  targets.forEach((path, index) => report(path, [jobIds[index]!]));
  if (jobIds.length > 1) report('TOTAL', jobIds);
} finally {
  await worker.stop();
  await engine.close();
  db.close();
  // Solo se borra la carpeta temporal creada por este script.
  assert.ok(
    owned.startsWith(resolve(tmpdir()) + sep) &&
      owned.includes('cybersoc-calibracion-'),
  );
  rmSync(owned, { recursive: true, force: true });
}
