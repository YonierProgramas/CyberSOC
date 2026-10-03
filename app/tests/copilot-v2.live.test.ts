import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { appConfigSchema } from '../src/core/config/AppConfig';
import type {
  AIProvider,
  AssistantTurnRequest,
} from '../src/core/ai/AIProvider';
import { ClaudeProvider } from '../src/core/ai/providers/ClaudeProvider';
import { FakeAIProvider } from '../src/core/ai/providers/FakeAIProvider';
import { AssistantOrchestrator } from '../src/core/ai/AssistantOrchestrator';
import { createToolRegistry } from '../src/core/ai/tools';
import { loadToolCatalog } from '../src/core/ai/ToolCatalogLoader';
import { ToolReadRepository } from '../src/core/persistence/ToolReadRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import type { ScanJobRecord } from '../src/core/persistence/ScanJobRepository';
import { ReportBuilder } from '../src/core/reports/ReportBuilder';
import { resolveZoneRoots } from '../src/main/zone-paths';
import type { AssistantReplyDTO } from '../src/shared/ipc';

// Carpetas "del usuario" de prueba: Descargas recibe los fixtures. Nunca rutas reales.
const live = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const base = joinPath(tmpdir(), `cybersoc-t55-live-${process.pid}`);
  const dirs = {
    downloads: joinPath(base, 'Downloads'),
    desktop: joinPath(base, 'Desktop'),
    documents: joinPath(base, 'Documents'),
    temp: joinPath(base, 'Temp'),
    appData: joinPath(base, 'AppData'),
  };
  return { base, dirs };
});
vi.mock('electron', () => ({
  app: {
    getPath: (name: keyof typeof live.dirs) => live.dirs[name] ?? live.base,
  },
  safeStorage: {},
}));
import { AIFlowHarness } from './fixtures/AIFlowHarness';
import { createScanOrchestrator } from '../src/main/composition-root';
import { ENGINE_DATA } from './fixtures/copilot';

// CI nunca llama a Claude, incluso si recibe una clave por error. Localmente requiere opt-in.
const skip =
  Boolean(process.env.CI) ||
  !process.env.CYBERSOC_ANTHROPIC_API_KEY?.trim() ||
  process.env.CYBERSOC_RUN_AI_LIVE !== '1';
if (skip)
  console.info(
    'COPILOT_V2_LIVE: OMITIDA. Requiere clave de desarrollo, CYBERSOC_RUN_AI_LIVE=1 y ejecución fuera de CI.',
  );

const engineRoot = resolve(import.meta.dirname, '../../engine');
const python = join(
  engineRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

interface Question {
  n: string;
  text: string;
  focus: () => { resultId?: string; jobId?: string } | undefined;
  /** Las preguntas del profesor empiezan una conversación nueva. */
  newConversation?: boolean;
}

describe.skipIf(skip)(
  'live — Copilot v2 con herramientas sobre la API de Claude',
  () => {
    let harness: AIFlowHarness | undefined;
    afterAll(async () => {
      await harness?.close();
      rmSync(live.base, { recursive: true, force: true });
    });

    it('responde las 10 preguntas del documento 7.2 y las 4 del profesor con datos reales', async () => {
      const outDir = process.env.CYBERSOC_T55_EVIDENCE_DIR;
      for (const dir of Object.values(live.dirs))
        mkdirSync(dir, { recursive: true });
      // Fixtures oficiales inofensivos del motor (nunca EICAR ni malware).
      execFileSync(
        python,
        [
          '-c',
          [
            'import runpy,sys',
            'from pathlib import Path',
            'g = runpy.run_path(sys.argv[1])',
            'root = Path(sys.argv[2])',
            'g["generate_signature_fixtures"](root)',
            'g["generate_rule_fixtures"](root)',
            'g["generate_heuristic_fixtures"](root)',
          ].join('; '),
          join(engineRoot, 'tests/fixtures/generate.py'),
          live.dirs.downloads,
        ],
        {
          env: { ...process.env, CYBERSOC_ANTHROPIC_API_KEY: '' },
          windowsHide: true,
          timeout: 20_000,
        },
      );
      writeFileSync(
        join(live.dirs.downloads, 'factura.pdf.exe'),
        'Documento benigno de doble extension.\n',
      );
      writeFileSync(
        join(live.dirs.downloads, 'informe_\u202e.pdf'),
        'Documento benigno con RLO en el nombre.\n',
      );
      writeFileSync(
        join(live.dirs.downloads, 'notas-reunion.txt'),
        'Notas limpias de una reunión.\n',
      );

      // Motor real + SQLite temporal. El análisis automático de IA no se inicia (no gasta llamadas).
      harness = new AIFlowHarness(() => new FakeAIProvider());
      await harness.prepare();
      const db = harness.db;
      const scan = createScanOrchestrator(db, harness.engine, harness.worker);
      const finished = new Promise<ScanJobRecord>((done) =>
        scan.once('finished', done),
      );
      const jobId = scan.start({ kind: 'FOLDER', path: live.dirs.downloads });
      const job = await finished;
      expect(job.status).toBe('COMPLETED');
      const results = new ScanResultRepository(db).listByJob(jobId, 0, 100);
      const byName = (name: string) =>
        results.find((row) => row.fileName === name)!;
      const signature = byName('CSD-TEST-001.txt');
      const rule = byName('rule_downloader.ps1');
      const suspicious =
        results.find(
          (row) =>
            row.verdict === 'SUSPICIOUS' && row.fileName === 'factura.pdf.exe',
        ) ?? results.find((row) => row.verdict === 'SUSPICIOUS')!;
      const second = byName('CSD-TEST-002.txt');
      expect(signature.verdict).toBe('DETECTED');
      const verdictsBefore = db
        .prepare('SELECT id, verdict, risk_level FROM scan_results ORDER BY id')
        .all();

      const config = appConfigSchema.parse({});
      const reports = new ReportBuilder(db);
      const tools = createToolRegistry(
        {
          reads: new ToolReadRepository(db),
          catalog: loadToolCatalog(ENGINE_DATA),
          zoneRoots: () =>
            resolveZoneRoots((name) => live.dirs[name], process.env),
          // No hay USB física en el equipo de pruebas: se simula una unidad E: conectada.
          removableDrives: async () => [{ driveId: 'E:', path: 'E:\\' }],
        },
        reports,
      );
      const claude = new ClaudeProvider({
        apiKey: process.env.CYBERSOC_ANTHROPIC_API_KEY!,
        model: config.ai.assistantModel,
      });
      const calls: {
        inputTokens: number;
        outputTokens: number;
        ok: boolean;
        kind?: string;
      }[] = [];
      const recording: AIProvider = {
        id: claude.id,
        healthCheck: () => claude.healthCheck(),
        generateStructured: (req) => claude.generateStructured(req),
        async runAssistantTurn<T = string>(req: AssistantTurnRequest<T>) {
          const result = await claude.runAssistantTurn(req);
          calls.push(
            result.ok
              ? {
                  ok: true,
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                }
              : {
                  ok: false,
                  kind: result.error.kind,
                  inputTokens: result.error.usage?.inputTokens ?? 0,
                  outputTokens: result.error.usage?.outputTokens ?? 0,
                },
          );
          return result;
        },
      };
      const assistant = new AssistantOrchestrator({
        db,
        provider: () => recording,
        readConfig: () => config,
        tools,
        reports,
      });

      const questions: Question[] = [
        {
          n: '1',
          text: '¿Por qué este archivo fue marcado como sospechoso?',
          focus: () => ({ resultId: suspicious.id }),
        },
        {
          n: '2',
          text: 'Explícame esta detección.',
          focus: () => ({ resultId: signature.id }),
        },
        {
          n: '3',
          text: '¿Qué regla se activó?',
          focus: () => ({ resultId: rule.id }),
        },
        {
          n: '4',
          text: '¿Qué significa este SHA-256?',
          focus: () => ({ resultId: signature.id }),
        },
        {
          n: '5',
          text: '¿Qué comportamiento resulta sospechoso?',
          focus: () => ({ resultId: rule.id }),
        },
        { n: '6', text: 'Resume el último escaneo.', focus: () => undefined },
        {
          n: '7',
          text: 'Muéstrame los archivos con mayor riesgo.',
          focus: () => ({ jobId }),
        },
        {
          n: '8',
          text: '¿Qué debería hacer con esta detección?',
          focus: () => ({ resultId: signature.id }),
        },
        {
          n: '9',
          text: 'Explícame este resultado de forma sencilla.',
          focus: () => ({ resultId: suspicious.id }),
        },
        {
          n: '10',
          text: '¿Qué diferencias existen entre estas dos detecciones?',
          focus: () => ({ resultId: second.id }),
        },
        {
          n: 'P1',
          text: '¿Qué capa detectó este archivo?',
          focus: () => ({ resultId: signature.id }),
          newConversation: true,
        },
        {
          n: 'P2',
          text: '¿Qué capas revisaron Descargas?',
          focus: () => undefined,
        },
        {
          n: 'P3',
          text: 'Hazme un reporte de los sospechosos de hoy',
          focus: () => undefined,
        },
        {
          n: 'P4',
          text: 'Voy a revisar mi USB, ¿cómo la escaneo?',
          focus: () => undefined,
        },
      ];

      const transcript: string[] = [
        '# Transcripciones reales del SOC Copilot v2 (T5.5)',
        '',
        `- Fecha UTC: ${new Date().toISOString()}`,
        `- Modelo (ai.assistantModel): \`${config.ai.assistantModel}\` vía API de Claude. Fase 1: 14 herramientas con \`strict: true\`. Fase 2 (solo si la fase 1 no entregó el JSON válido): \`output_config.format\` con \`tool_choice: none\`. La API rechaza ambas cosas en una misma petición con estas 14 herramientas ("compiled grammar is too large").`,
        `- Prueba: \`tests/copilot-v2.live.test.ts\` (opt-in \`CYBERSOC_RUN_AI_LIVE=1\`; nunca en CI). La clave no se registra.`,
        `- Datos: escaneo real (motor Python) de ${results.length} fixtures inofensivos generados por \`engine/tests/fixtures/generate.py\` en una carpeta Descargas de prueba (\`${job.id}\`). Nunca EICAR ni malware.`,
        '- **USB simulada:** el equipo de pruebas no tiene una USB física conectada; `list_zones` devuelve una unidad extraíble `E:` simulada para la pregunta P4.',
        '- Las preguntas 1–10 van en una misma conversación (ventana de 10 turnos); las 4 del profesor (P1–P4) empiezan una conversación nueva.',
        '- "Herramientas llamadas" son las que pidió el modelo (guardadas en `ai_messages`), con sus argumentos exactos.',
        '',
        '## Archivos escaneados',
        '',
        '| resultId | Archivo | Veredicto | Puntos | Zona |',
        '|---|---|---|---|---|',
        ...results.map(
          (row) =>
            `| \`${row.id}\` | ${row.fileName.replace('\u202e', '[RLO]')} | ${row.verdict} | ${row.engineScore ?? '—'} | ${row.zone ?? '—'} |`,
        ),
        '',
      ];
      const replies: Record<string, AssistantReplyDTO> = {};
      for (const question of questions) {
        if (question.newConversation) assistant.reset();
        const lastRow = Number(
          db
            .prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM ai_messages')
            .get()!.n,
        );
        const callsBefore = calls.length;
        const focus = question.focus();
        const reply = await assistant.ask({
          message: question.text,
          ...(focus ? { focus } : {}),
        });
        replies[question.n] = reply;
        const used = calls.slice(callsBefore);
        const toolRows = db
          .prepare(
            "SELECT tool_calls_json AS calls FROM ai_messages WHERE role = 'tool' AND rowid > ? ORDER BY rowid",
          )
          .all(lastRow)
          .flatMap(
            (row) =>
              JSON.parse(String(row.calls)) as {
                name: string;
                input: unknown;
                ok: boolean;
                code?: string;
              }[],
          );
        transcript.push(
          `## ${question.n}. ${question.text}`,
          '',
          `- Foco: ${focus?.resultId ? `resultado \`${focus.resultId}\` (${reply.focus.label?.replace('\u202e', '[RLO]')})` : focus?.jobId ? `escaneo \`${focus.jobId}\`` : 'ninguno'}`,
          `- Estado: **${reply.status}**${reply.errorKind ? ` (${reply.errorKind})` : ''} · llamadas a Claude: ${used.length} · tokens: ${used.reduce((s, c) => s + c.inputTokens, 0)} entrada / ${used.reduce((s, c) => s + c.outputTokens, 0)} salida`,
          `- Herramientas llamadas (${toolRows.length}):${toolRows.length ? '' : ' ninguna'}`,
          ...toolRows.map(
            (call, i) =>
              `  ${i + 1}. \`${call.name}(${JSON.stringify(call.input)})\` → ${call.ok ? 'ok' : `error ${call.code}`}`,
          ),
          '- Respuesta (texto plano mostrado al usuario):',
          '',
          ...reply.text
            .split('\n')
            .map((line) => `  > ${line.replace('\u202e', '[RLO]')}`),
          '',
          `- Referencias (validadas por el Core): ${reply.references.length ? reply.references.map((ref) => `${ref.type} \`${ref.id}\``).join(', ') : 'ninguna'}`,
          `- Acciones sugeridas (requieren confirmación): ${reply.suggestedActions.length ? reply.suggestedActions.map((a) => `${a.action}${a.targetId ? ` \`${a.targetId}\`` : ''}`).join(', ') : 'ninguna'}`,
          ...(reply.report
            ? [
                `- Tarjeta de reporte: borrador \`${reply.report.reportDraftId}\` · total ${reply.report.total} · ${reply.report.verdicts.map((v) => `${v.verdict}=${v.count}`).join(', ')} · resumen IA: "${reply.report.executiveSummary}" · cita: ${reply.report.citedResultIds.join(', ')}`,
              ]
            : []),
          ...(reply.scanPlan
            ? [
                `- Tarjeta de plan: destinos ${reply.scanPlan.targets.map((t) => `${t.zoneId}${t.driveId ? ` ${t.driveId}` : ''}`).join(', ')} · capas ${reply.scanPlan.profile.layers.join(', ')} · ocultos ${reply.scanPlan.profile.includeHidden} · ${reply.scanPlan.profile.maxFileSizeMB} MB · "${reply.scanPlan.rationale}"`,
              ]
            : []),
          ...(reply.rejected.length
            ? [`- Rechazos del Core: ${reply.rejected.join(' | ')}`]
            : []),
          '',
        );
      }

      const verdictsAfter = db
        .prepare('SELECT id, verdict, risk_level FROM scan_results ORDER BY id')
        .all();
      expect(verdictsAfter).toEqual(verdictsBefore);
      const jobsAfter = Number(
        db.prepare('SELECT COUNT(*) AS n FROM scan_jobs').get()!.n,
      );
      const answered = Object.values(replies).filter(
        (reply) => reply.status === 'ANSWERED',
      ).length;
      transcript.push(
        '## Comprobaciones finales',
        '',
        `- Respondidas: ${answered} de ${questions.length}.`,
        `- Llamadas a Claude: ${calls.length} · tokens totales: ${calls.reduce((s, c) => s + c.inputTokens, 0)} entrada / ${calls.reduce((s, c) => s + c.outputTokens, 0)} salida.`,
        `- Veredictos idénticos antes y después de las 14 preguntas: ${JSON.stringify(verdictsAfter) === JSON.stringify(verdictsBefore) ? 'sí' : 'NO'}.`,
        `- Escaneos en la BD tras proponer el plan de la USB: ${jobsAfter} (el único es el escaneo de los fixtures: el Copilot no inició ninguno).`,
        '',
      );
      expect(jobsAfter).toBe(1);

      // CA-5.1: cifras de "Resume el último escaneo" frente a SQL directo.
      const sqlJob = db
        .prepare(
          `SELECT id, status, files_discovered AS discovered, files_processed AS processed,
           files_error AS errors, files_skipped AS skipped, bytes_processed AS bytes,
           started_at AS startedAt, finished_at AS finishedAt,
           CAST(ROUND((julianday(finished_at) - julianday(started_at)) * 86400000) AS INTEGER) AS durationMs
         FROM scan_jobs ORDER BY created_at DESC LIMIT 1`,
        )
        .get()!;
      const sqlVerdicts = db
        .prepare(
          'SELECT verdict, COUNT(*) AS n FROM scan_results WHERE job_id = ? GROUP BY verdict ORDER BY verdict',
        )
        .all(String(sqlJob.id));
      const sqlTop = db
        .prepare(
          `SELECT id, file_name AS fileName, verdict, engine_score AS score FROM scan_results
         WHERE job_id = ? AND engine_score IS NOT NULL ORDER BY engine_score DESC, seq LIMIT 5`,
        )
        .all(String(sqlJob.id));
      const summary = replies['6']!;
      const facts = new Set<string>([
        ...Object.values(sqlJob)
          .filter((v) => typeof v === 'number')
          .map(String),
        ...sqlVerdicts.map((row) => String(row.n)),
        ...sqlTop.map((row) => String(row.score)),
        String(results.length),
        // Bytes expresados en KB con un decimal, como suele escribirlos el modelo.
        (Number(sqlJob.bytes) / 1024).toFixed(1),
        // Diferencia de una unidad por redondeo de milisegundos.
        String(Number(sqlJob.durationMs) - 1),
        String(Number(sqlJob.durationMs) + 1),
      ]);
      // Fechas, horas y números dentro de nombres (CSD-TEST-001) no son cifras del escaneo.
      const comparable = summary.text
        .replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, ' ')
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
        .replace(/[A-Za-z_-]+-\d+/g, ' ');
      const numbers = [...comparable.matchAll(/\d+(?:[.,]\d+)?/g)].map(
        (m) => m[0],
      );
      const comparison = [
        'Evidencia 01 — "Resume el último escaneo": cifras de la respuesta frente a SQL directo (T5.5, CA-5.1)',
        `Fecha UTC: ${new Date().toISOString()}`,
        'Origen: tests/copilot-v2.live.test.ts (misma ejecución que 02-transcripciones-preguntas.md). Modelo: ' +
          config.ai.assistantModel,
        '',
        '--- SQL directo ---',
        'SELECT id, status, files_discovered, files_processed, files_error, files_skipped, bytes_processed, started_at, finished_at, (finished_at - started_at en ms) FROM scan_jobs ORDER BY created_at DESC LIMIT 1;',
        JSON.stringify(sqlJob, null, 2),
        '',
        'SELECT verdict, COUNT(*) FROM scan_results WHERE job_id = ? GROUP BY verdict;',
        JSON.stringify(sqlVerdicts, null, 2),
        '',
        'SELECT id, file_name, verdict, engine_score FROM scan_results WHERE job_id = ? AND engine_score IS NOT NULL ORDER BY engine_score DESC, seq LIMIT 5;',
        JSON.stringify(
          sqlTop.map((row) => ({
            ...row,
            fileName: String(row.fileName).replace('\u202e', '[RLO]'),
          })),
          null,
          2,
        ),
        '',
        '--- Respuesta del Copilot ---',
        `Estado: ${summary.status} · herramientas: ${summary.toolCalls.map((c) => c.name).join(', ') || 'ninguna'}`,
        summary.text.replace(/\u202e/g, '[RLO]'),
        '',
        '--- Comparación automática de cada cifra de la respuesta ---',
        '(Se excluyen fechas, horas y números que forman parte de nombres como CSD-TEST-001.)',
        ...(numbers.length
          ? numbers.map(
              (value) =>
                `${value.padStart(8)}  ${facts.has(value.replace(',', '.')) ? 'COINCIDE con un valor de SQL' : 'NO COINCIDE con SQL (revisar a mano)'}`,
            )
          : ['(la respuesta no contiene cifras)']),
        '',
        `Resultado: ${numbers.filter((v) => facts.has(v.replace(',', '.'))).length} de ${numbers.length} números coinciden con SQL.`,
      ].join('\n');

      const text = transcript.join('\n');
      const key = process.env.CYBERSOC_ANTHROPIC_API_KEY!;
      expect(text).not.toContain(key);
      expect(comparison).not.toContain(key);
      if (outDir) {
        writeFileSync(
          join(outDir, '02-transcripciones-preguntas.md'),
          text,
          'utf8',
        );
        writeFileSync(
          join(outDir, '01-resumen-vs-sql.txt'),
          comparison,
          'utf8',
        );
      }
      console.info(text);
      console.info(comparison);
    }, 600_000);
  },
);
