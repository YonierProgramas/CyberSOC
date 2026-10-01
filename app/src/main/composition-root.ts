import { app, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Database } from '../core/persistence/Database';
import { MigrationRunner } from '../core/persistence/MigrationRunner';
import {
  asEngineLogger,
  EngineProcess,
  parseEngineCommand,
} from '../core/engine/EngineProcess';
import { createLogger } from '../core/logging/logger';
import { AppConfigStore } from '../core/config/AppConfig';
import {
  ScanJobRepository,
  type ScanJobRecord,
} from '../core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../core/persistence/ScanResultRepository';
import { EvidenceRepository } from '../core/persistence/EvidenceRepository';
import { LayerTraceRepository } from '../core/persistence/LayerTraceRepository';
import { decideRisk } from '../core/risk/RiskPolicy';
import {
  ScanOrchestrator,
  type ScanEngine,
} from '../core/scan/ScanOrchestrator';
import { ClaudeProvider } from '../core/ai/providers/ClaudeProvider';
import { FakeAIProvider } from '../core/ai/providers/FakeAIProvider';
import type {
  AIErrorKind,
  AIProvider,
  AIResult,
  StructuredRequest,
} from '../core/ai/AIProvider';
import { jobSummaryContextSchema, jobSummarySchema } from '../core/ai/schemas';
import { AIAnalysisStore } from '../core/ai/AIAnalysisStore';
import { AISecurityService } from '../core/ai/AISecurityService';
import { AIAnalysisWorker } from '../core/ai/AIAnalysisWorker';
import { JobSummaryService } from '../core/ai/JobSummaryService';
import { JobSummaryStore } from '../core/ai/JobSummaryStore';
import type { AIHealthCheck } from '../shared/ipc';
import type { AppLogger } from '../core/logging/logger';
import { SecretStore } from './SecretStore';
import type { AISettingsService } from './ipc/settings.ipc';
import { ZoneClassifier } from '../core/zones/ZoneClassifier';
import { ScanProfiles } from '../core/zones/ScanProfiles';
import { resolveZoneRoots } from './zone-paths';
import { HiddenPathReader } from './HiddenPathReader';

let evidenceRoot: string | undefined;

/** Solo el opt-in explícito aísla datos y sustituye el diálogo nativo. */
function prepareEvidenceMode(): string | undefined {
  if (process.env.CYBERSOC_EVIDENCE_MODE !== '1') return undefined;
  if (evidenceRoot) return evidenceRoot;
  const root = process.env.CYBERSOC_EVIDENCE_ROOT
    ? resolve(process.env.CYBERSOC_EVIDENCE_ROOT)
    : mkdtempSync(join(tmpdir(), 'cybersoc-evidence-'));
  // El capturador solo puede reutilizar un directorio propio: el temporal del sistema
  // o Public, porque AppData oculto haría que un perfil sin ocultos no vea fixtures.
  const parent = realpathSync(dirname(root));
  const allowedParents = [realpathSync(tmpdir())];
  if (process.env.PUBLIC) {
    try {
      allowedParents.push(realpathSync(process.env.PUBLIC));
    } catch {
      // Public no está disponible; solo se acepta el temporal del sistema.
    }
  }
  if (
    !allowedParents.includes(parent) ||
    !basename(root).startsWith('cybersoc-evidence-') ||
    realpathSync(root) !== root
  ) {
    throw new Error(
      'El modo evidencia requiere un directorio temporal aislado.',
    );
  }
  const userData = join(root, 'user-data');
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  dialog.showOpenDialog = (async () => {
    const path = process.env.CYBERSOC_EVIDENCE_DIALOG_PATH;
    return { canceled: !path, filePaths: path ? [path] : [] };
  }) as typeof dialog.showOpenDialog;
  evidenceRoot = root;
  return root;
}

function evidenceDelay(): Promise<void> {
  const milliseconds = Number(process.env.CYBERSOC_EVIDENCE_SCAN_DELAY_MS ?? 0);
  return new Promise((done) =>
    setTimeout(done, Math.min(5_000, Math.max(0, milliseconds || 0))),
  );
}

export function createSecretStore(database: Database): SecretStore {
  return new SecretStore(database, {
    developmentKey: () =>
      app.isPackaged ? undefined : process.env.CYBERSOC_ANTHROPIC_API_KEY,
  });
}

/** El ciclo de vida de main inicia/detiene este worker; el proveedor se lee por petición. */
export function createAIWorkflow(
  database: Database,
  provider: () => AIProvider | null = () => createAIProvider(database),
): AIAnalysisWorker {
  const config = new AppConfigStore(database);
  return new AIAnalysisWorker(
    new AISecurityService(new AIAnalysisStore(database), provider, () =>
      config.load(),
    ),
    () => config.load().ai.autoAnalyzeLimitPerScan,
    new JobSummaryService(new JobSummaryStore(database), provider, () =>
      config.load(),
    ),
  );
}

export function createAIProvider(
  database: Database,
  secrets = createSecretStore(database),
): ClaudeProvider | FakeAIProvider | null {
  if (
    process.env.CYBERSOC_EVIDENCE_MODE === '1' &&
    process.env.CYBERSOC_EVIDENCE_LIVE !== '1'
  ) {
    // Respuesta fija y explícitamente simulada. Atraviesa el validador y RiskPolicy.
    const escalation = process.env.CYBERSOC_EVIDENCE_SCENARIO === 'escalation';
    const provider = new EvidenceAIProvider({ model: 'fake-evidence-v1' });
    const value = escalation
      ? {
          schema: 'cybersoc.ai-assessment/v1',
          summary:
            'Demostración con FakeAIProvider: hay motivo para revisar este archivo limpio.',
          plainExplanation:
            'El motor lo dejó limpio, pero la evidencia citada merece una revisión humana.',
          technicalAnalysis:
            'La opinión simulada cita ev1, con confianza suficiente para el escalamiento de demostración.',
          correlations: [
            {
              evidenceIds: ['ev1'],
              insight:
                'La evidencia ev1 está incluida en el contexto validado.',
            },
          ],
          opinion: 'SUSPICIOUS',
          confidence: 0.8,
          recommendedAction: 'VERIFY_SOURCE',
          actionRationale:
            'Revisar el origen del archivo y las evidencias del motor.',
          falsePositiveNotes: 'Fixture de demostración; no contiene malware.',
          citedEvidenceIds: ['ev1'],
        }
      : {
          schema: 'cybersoc.ai-assessment/v1',
          summary:
            'Demostración con FakeAIProvider: el motor registró evidencia ev1.',
          plainExplanation:
            'Este es un fixture inofensivo de prueba. La explicación simulada permite comprobar la interfaz sin consumir la API.',
          technicalAnalysis:
            'La evidencia ev1 procede del motor local. El proveedor simulado no lee contenido del archivo ni cambia el veredicto del motor.',
          correlations: [
            {
              evidenceIds: ['ev1'],
              insight:
                'La evidencia ev1 está incluida en el contexto validado.',
            },
          ],
          opinion: 'INSUFFICIENT_EVIDENCE',
          confidence: 0,
          recommendedAction: 'VERIFY_SOURCE',
          actionRationale:
            'Revisar el origen del archivo y las evidencias del motor.',
          falsePositiveNotes: 'Fixture de demostración; no contiene malware.',
          citedEvidenceIds: ['ev1'],
        };
    for (let copy = 0; copy < (escalation ? 60 : 1); copy += 1)
      provider.enqueueValue(value);
    return provider;
  }
  try {
    const apiKey = secrets.getApiKey();
    if (apiKey === null) return null;
    return new ClaudeProvider({
      apiKey,
      model: new AppConfigStore(database).load().ai.analysisModel,
    });
  } catch {
    throw new Error('No se pudo preparar el proveedor de IA.');
  }
}

export function createAISettings(
  database: Database,
  options: {
    secrets?: SecretStore;
    logger?: Pick<AppLogger, 'info' | 'warn'>;
    onReady?: () => void;
  } = {},
): AISettingsService {
  const secrets = options.secrets ?? createSecretStore(database);
  const logger =
    options.logger ?? createLogger(join(app.getPath('userData'), 'logs'));
  const notifyReady = () => {
    try {
      options.onReady?.();
    } catch {
      logger.warn(
        { component: 'ai' },
        'No se pudo reanudar el análisis de IA.',
      );
    }
  };
  return {
    setApiKey(key) {
      try {
        secrets.setApiKey(key);
        logger.info(
          { component: 'settings' },
          'API key guardada de forma cifrada.',
        );
        notifyReady();
      } catch {
        logger.warn(
          { component: 'settings' },
          'No se pudo guardar la API key.',
        );
        throw new Error('No se pudo guardar la API key.');
      }
    },
    clearApiKey() {
      try {
        secrets.clearApiKey();
        logger.info({ component: 'settings' }, 'API key guardada eliminada.');
      } catch {
        logger.warn(
          { component: 'settings' },
          'No se pudo eliminar la API key.',
        );
        throw new Error('No se pudo eliminar la API key.');
      }
    },
    getStatus() {
      try {
        return {
          ...secrets.getStatus(),
          model: new AppConfigStore(database).load().ai.analysisModel,
        };
      } catch {
        throw new Error('No se pudo consultar la configuración de IA.');
      }
    },
    async testConnection(): Promise<AIHealthCheck> {
      try {
        // Crear por petición evita usar una clave vieja tras reemplazarla/eliminarla.
        const provider = createAIProvider(database, secrets);
        if (provider === null)
          return {
            ok: false,
            error: {
              kind: 'AUTH',
              retryable: false,
              message: 'Configura una API key para probar la conexión.',
            },
          };
        const result = await provider.healthCheck();
        if (result.ok) {
          notifyReady();
          logger.info({ component: 'settings' }, 'Conexión de IA comprobada.');
          // Solo datos locales y numéricos: ni cuerpos HTTP ni model devuelto por la red.
          return {
            ok: true,
            value: { model: provider.model },
            model: provider.model,
            usage: { inputTokens: 0, outputTokens: 0 },
            latencyMs: result.latencyMs,
          };
        }
        logger.warn(
          { component: 'settings' },
          'No se pudo comprobar la conexión de IA.',
        );
        return {
          ok: false,
          error: {
            kind: result.error.kind,
            retryable: result.error.retryable,
            message: connectionErrorMessage(result.error.kind),
            ...(result.error.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: result.error.retryAfterMs }),
          },
        };
      } catch {
        logger.warn(
          { component: 'settings' },
          'Fallo al preparar o comprobar la conexión de IA.',
        );
        return {
          ok: false,
          error: {
            kind: 'PROVIDER_DOWN',
            retryable: false,
            message: 'No se pudo comprobar la conexión de IA.',
          },
        };
      }
    },
  };
}

/** Solo se instancia en modo evidencia sin --live: simula el modelo, nunca la política. */
class EvidenceAIProvider extends FakeAIProvider {
  override async generateStructured<T>(
    request: StructuredRequest<T>,
  ): Promise<AIResult<T>> {
    if (!Object.is(request.schema, jobSummarySchema))
      return super.generateStructured(request);
    const json = request.prompt.match(
      /^<contexto>\n([\s\S]*?)\n<\/contexto>$/m,
    )?.[1];
    const context = jobSummaryContextSchema.parse(JSON.parse(json ?? '{}'));
    const first = context.topResults[0];
    const summary = {
      summary:
        'Demostración con FakeAIProvider: escaneo completado; consulte las evidencias de los resultados.',
      highlights: first
        ? [
            {
              resultId: first.resultId,
              why: 'Resultado seleccionado entre los de mayor riesgo del escaneo.',
            },
          ]
        : [],
      recommendations: ['Revisar el origen de los archivos señalados.'],
      citedResultIds: first ? [first.resultId] : [],
    };
    return new FakeAIProvider({ model: this.model })
      .enqueueValue(summary)
      .generateStructured(request);
  }
}

function connectionErrorMessage(kind: AIErrorKind): string {
  switch (kind) {
    case 'AUTH':
      return 'La API de Claude rechazó la credencial.';
    case 'OFFLINE':
      return 'Sin conexión con la API de Claude.';
    case 'TIMEOUT':
      return 'La API de Claude no respondió a tiempo.';
    case 'RATE_LIMIT':
      return 'Se alcanzó el límite de peticiones de Claude.';
    default:
      return 'No se pudo comprobar la conexión de IA.';
  }
}

export function createScanOrchestrator(
  database: Database,
  engine: ScanEngine & Pick<EngineProcess, 'driveInfo' | 'stats'>,
  worker?: Pick<AIAnalysisWorker, 'enqueueAutomatic'> &
    Partial<Pick<AIAnalysisWorker, 'enqueueJobSummary'>>,
): ScanOrchestrator {
  const config = new AppConfigStore(database);
  const results = new ScanResultRepository(database);
  const roots = resolveZoneRoots((name) => app.getPath(name), process.env);
  const orchestrator = new ScanOrchestrator({
    profiles: new ScanProfiles(database),
    stats: () => engine.stats(),
    createZoneSession: () => {
      const classifier = new ZoneClassifier(roots, (path) =>
        engine.driveInfo(path),
      );
      const attributes = new HiddenPathReader();
      return {
        classify: (path) =>
          process.platform === 'win32'
            ? classifier.classify(path)
            : Promise.resolve('OTRA' as const),
        isHidden: (path) => attributes.isHidden(path),
        close: () => attributes.close(),
      };
    },
    config: () => config.load(),
    engine:
      process.env.CYBERSOC_EVIDENCE_MODE === '1'
        ? {
            getState: () => engine.getState(),
            reconnect: () => engine.reconnect(),
            async scanFile(params, timeoutMs) {
              // Solo ralentiza la demostración; ni fabrica ni modifica resultados.
              await evidenceDelay();
              return engine.scanFile(params, timeoutMs);
            },
          }
        : engine,
    jobs: new ScanJobRepository(database),
    results,
    persistResult(record, result) {
      const verdict = result.verdict;
      const decision =
        result.score != null &&
        (verdict === 'CLEAN' ||
          verdict === 'SUSPICIOUS' ||
          verdict === 'DETECTED')
          ? decideRisk({ verdict, score: result.score })
          : null;
      const detectedType = result.evidence.find(
        (e) => e.code === 'TYPE_MISMATCH',
      )?.facts.detectedType;
      const enriched = {
        ...record,
        detectedType: typeof detectedType === 'string' ? detectedType : null,
      };
      database.transaction(() => {
        if (decision || result.status !== 'SCANNED') {
          results.insertComplete({
            result: enriched,
            evidence: result.evidence,
            layers: result.layers,
            assessment: decision
              ? {
                  engineVerdict: decision.engineVerdict,
                  engineScore: decision.engineScore,
                  finalVerdict: decision.finalVerdict,
                  finalLevel: decision.finalLevel,
                  reviewRequired: decision.reviewRequired,
                  origin: decision.origin,
                  traceJson: JSON.stringify(decision.trace),
                  policyVersion: decision.policyVersion,
                }
              : null,
          });
        } else {
          // Compatibilidad con respuestas v1 anteriores a T2.3: conservar los hechos
          // sin inventar una puntuación o declarar CLEAN un resultado no evaluado.
          results.insertResult(enriched);
          new EvidenceRepository(database).insertMany(
            record.id,
            result.evidence,
          );
          new LayerTraceRepository(database).insertTrace(
            record.id,
            result.layers,
          );
        }
      });
      // La IA falla de forma independiente: el resultado local ya está confirmado.
      try {
        worker?.enqueueAutomatic(record.id);
      } catch {
        console.error('No se pudo encolar el análisis de IA.');
      }
    },
    onError: (error) => console.error('Error de escaneo:', error),
  });
  // JOB_SUMMARY: cada escaneo completado encola su resumen de IA. Igual que el análisis por
  // archivo, un fallo de la IA no afecta al escaneo ya guardado.
  orchestrator.on('finished', (job: ScanJobRecord) => {
    if (job.status !== 'COMPLETED') return;
    try {
      worker?.enqueueJobSummary?.(job.id);
    } catch {
      console.error('No se pudo encolar el resumen de IA.');
    }
  });
  return orchestrator;
}

export function createDatabase(userDataPath: string): Database {
  const root = prepareEvidenceMode();
  if (root) userDataPath = join(root, 'user-data');
  const database = new Database(join(userDataPath, 'cybersoc.db'));
  try {
    new MigrationRunner(database).run();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function createEngine(
  appRoot: string,
  userDataPath = app.getPath('userData'),
): EngineProcess {
  const root = prepareEvidenceMode();
  if (root) userDataPath = join(root, 'user-data');
  const logger = createLogger(join(userDataPath, 'logs'));
  logger.info({ component: 'core' }, 'Logging started');
  return new EngineProcess({
    // La alternativa de desarrollo pertenece a main; el proceso Python no la necesita.
    spawnProcess: ((
      file: string,
      args: string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      const env = { ...options?.env };
      delete env.CYBERSOC_ANTHROPIC_API_KEY;
      const child = spawn(file, args, {
        ...options,
        env,
        ...(root ? { windowsHide: true } : {}),
      });
      if (root && child.pid) {
        writeFileSync(
          join(root, 'engine-pid.json'),
          JSON.stringify({
            pid: child.pid,
            parentPid: process.pid,
          }),
          { mode: 0o600 },
        );
      }
      return child;
    }) as typeof spawn,
    cwd: appRoot,
    command: () =>
      process.env.CYBERSOC_ENGINE_CMD !== undefined
        ? parseEngineCommand(process.env.CYBERSOC_ENGINE_CMD)
        : {
            file: join(
              appRoot,
              '..',
              'engine',
              '.venv',
              process.platform === 'win32'
                ? 'Scripts/python.exe'
                : 'bin/python',
            ),
            args: ['-m', 'cybersoc_engine'],
          },
    logger: asEngineLogger(logger),
  });
}
