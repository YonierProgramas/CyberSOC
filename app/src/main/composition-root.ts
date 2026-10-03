import { app, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
  AssistantMessage,
  AssistantStep,
  AssistantTurnRequest,
  StructuredRequest,
} from '../core/ai/AIProvider';
import { createToolRegistry } from '../core/ai/tools';
import type { ToolRegistry } from '../core/ai/tools/ToolRegistry';
import { ToolReadRepository } from '../core/persistence/ToolReadRepository';
import { ToolCatalogRepository } from '../core/persistence/ToolCatalogRepository';
import { loadToolCatalog } from '../core/ai/ToolCatalogLoader';
import type { ReportBuilder } from '../core/reports/ReportBuilder';
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
import { AllowlistRepository } from '../core/persistence/AllowlistRepository';
import {
  QuarantineManager,
  type QuarantineOptions,
} from '../core/quarantine/QuarantineManager';
import { QuarantineVault } from '../core/quarantine/QuarantineVault';
import { ProtectedPaths } from '../core/quarantine/paths';

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
  // La ventana nace oculta. Con recordVideo, Playwright no llega a pintar
  // esa ventana hasta que se muestra. Solo aplica a este modo.
  app.on('browser-window-created', (_event, window) => {
    window.show();
  });
  dialog.showOpenDialog = (async () => {
    const path = process.env.CYBERSOC_EVIDENCE_DIALOG_PATH;
    return { canceled: !path, filePaths: path ? [path] : [] };
  }) as typeof dialog.showOpenDialog;
  dialog.showSaveDialog = (async () => {
    const selected = process.env.CYBERSOC_EVIDENCE_SAVE_PATH ?? '';
    if (!selected) return { canceled: true, filePath: '' };
    const file = resolve(selected);
    const base = resolve(root);
    if (file !== base && !file.startsWith(base + sep)) {
      return { canceled: true, filePath: '' };
    }
    return { canceled: false, filePath: file };
  }) as typeof dialog.showSaveDialog;
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
    const configured = Number(process.env.CYBERSOC_EVIDENCE_REPLIES ?? '');
    const copies =
      Number.isInteger(configured) && configured > 0
        ? Math.min(configured, 60)
        : escalation
          ? 60
          : 1;
    for (let copy = 0; copy < copies; copy += 1) provider.enqueueValue(value);
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

/**
 * Herramientas de SOLO lectura del Copilot v2 (T5.3) con datos reales: SQLite, catálogo de
 * reglas y firmas del motor, zonas resueltas de este equipo y unidades extraíbles conectadas.
 * La IA nunca aporta rutas: todas salen de aquí.
 */
export function createAssistantTools(
  database: Database,
  engine: Pick<EngineProcess, 'driveInfo'>,
  reports: ReportBuilder,
  appRoot = app.getAppPath(),
): ToolRegistry {
  const roots = resolveZoneRoots((name) => app.getPath(name), process.env);
  let catalog: ToolCatalogRepository;
  try {
    catalog = loadToolCatalog(join(appRoot, '..', 'engine', 'data'));
  } catch {
    // Sin catálogo, get_rule_info y lookup_hash responden NOT_FOUND; el chat sigue.
    console.error('No se pudo cargar el catálogo de reglas y firmas.');
    catalog = new ToolCatalogRepository([], []);
  }
  return createToolRegistry(
    {
      reads: new ToolReadRepository(database),
      catalog,
      zoneRoots: () => roots,
      removableDrives: () => removableDrives(engine),
    },
    reports,
  );
}

/** Unidades D: a Z: que existen y que el motor clasifica como REMOVABLE. */
async function removableDrives(
  engine: Pick<EngineProcess, 'driveInfo'>,
): Promise<{ driveId: string; path: string }[]> {
  if (process.platform !== 'win32') return [];
  const drives: { driveId: string; path: string }[] = [];
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const path = `${letter}:\\`;
    try {
      await access(path);
      if ((await engine.driveInfo(path)).driveType === 'REMOVABLE')
        drives.push({ driveId: `${letter}:`, path });
    } catch {
      // Letra sin unidad o motor desconectado: no se ofrece como destino.
    }
  }
  return drives;
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
    if (process.env.CYBERSOC_EVIDENCE_AI === 'OFFLINE') {
      return {
        ok: false,
        error: {
          kind: 'OFFLINE',
          retryable: false,
          message: 'Sin conexión simulada.',
        },
      };
    }
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

  /**
   * Solo en modo evidencia. OFFLINE simula que Claude no responde. Las preguntas del
   * guion S5 piden la herramienta que corresponde y arman la respuesta con sus IDs reales.
   * El resto sigue siendo texto del foco, sin herramientas.
   */
  override async runAssistantTurn<T = string>(
    request: AssistantTurnRequest<T>,
  ): Promise<AIResult<AssistantStep<T>>> {
    if (process.env.CYBERSOC_EVIDENCE_AI === 'OFFLINE') {
      return {
        ok: false,
        error: {
          kind: 'OFFLINE',
          retryable: true,
          message: 'Sin conexión simulada.',
        },
      };
    }
    const scripted = evidenceCopilotDecision(request.messages);
    if (scripted?.kind === 'tools' && request.toolChoice !== 'none') {
      const id = `toolu_evidence_${evidenceToolPayloads(request.messages).length + 1}`;
      const call = { id, name: scripted.name, input: scripted.input };
      return {
        ok: true,
        value: {
          kind: 'TOOL_CALLS',
          calls: [call],
          content: [{ type: 'tool_use', ...call }],
        },
        model: this.model,
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: 0,
        rawText: '',
      };
    }
    const wire =
      scripted?.kind === 'final'
        ? scripted.wire
        : evidencePlainWire(request.messages);
    const text = JSON.stringify(wire);
    try {
      const value = request.output ? request.output.parse(wire) : (text as T);
      return {
        ok: true,
        value: { kind: 'FINAL', value, text },
        model: this.model,
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: 0,
        rawText: text,
      };
    } catch {
      return {
        ok: false,
        error: {
          kind: 'INVALID_OUTPUT',
          retryable: true,
          message: 'El guion de evidencia no cumplió el esquema.',
        },
      };
    }
  }
}

interface EvidenceTool {
  name: string;
  ok: boolean;
  data: unknown;
}

type EvidenceDecision =
  | { kind: 'tools'; name: string; input: Record<string, unknown> }
  | { kind: 'final'; wire: Record<string, unknown> };

function evidencePlainWire(
  messages: readonly AssistantMessage[],
): Record<string, unknown> {
  const last = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'user' && typeof message.content === 'string',
    )?.content;
  const json = (typeof last === 'string' ? last : '').match(
    /<contexto>\n([\s\S]*?)\n<\/contexto>/,
  )?.[1];
  return {
    answer: evidenceAssistantText(json),
    references: [],
    suggestedActions: [],
    report: [],
    scanPlan: [],
  };
}

function evidenceCopilotDecision(
  messages: readonly AssistantMessage[],
): EvidenceDecision | null {
  const question = evidenceQuestion(messages)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  const focus = evidenceFocus(messages);
  const tools = evidenceToolPayloads(messages);
  if (question.includes('mayor riesgo')) return evidenceTop(focus, tools);
  if (question.includes('diferencia') || question.includes('compara'))
    return evidenceCompare(focus, tools);
  if (question.includes('reporte')) return evidenceReport(focus, tools);
  if (question.includes('capa')) return evidenceLayers(focus, tools);
  if (
    question.includes('escaneo') ||
    question.includes('como la escaneo') ||
    question.includes('usb')
  )
    return evidencePlan(tools);
  return null;
}

function evidenceTop(
  focus: { jobId: string | null },
  tools: readonly EvidenceTool[],
): EvidenceDecision {
  const done = tools.find(
    (tool) => tool.name === 'get_top_risk_results' && tool.ok,
  );
  if (!done)
    return {
      kind: 'tools',
      name: 'get_top_risk_results',
      input: { jobId: focus.jobId, k: 10 },
    };
  const rows = arrayField(done.data, 'rows');
  const detected = rows.find((row) => {
    const verdict = textField(row, 'verdict');
    return verdict === 'DETECTED' || verdict === 'SUSPICIOUS';
  });
  const detectedId = detected ? textField(detected, 'id') : '';
  const jobId = textField(isRecord(done.data) ? done.data : {}, 'jobId');
  const listed = rows
    .map(
      (row) =>
        `${textField(row, 'fileName')} (${textField(row, 'engineScore')}, ${textField(row, 'verdict')})`,
    )
    .join('; ');
  return {
    kind: 'final',
    wire: {
      answer: listed
        ? `Estos son los archivos con mayor riesgo según el motor: ${listed}.`
        : 'El motor no tiene archivos con puntuación en este escaneo.',
      references: [
        ...rows.slice(0, 10).flatMap((row) => {
          const id = textField(row, 'id');
          return id ? [{ type: 'result', id }] : [];
        }),
        ...(jobId ? [{ type: 'job', id: jobId }] : []),
      ],
      suggestedActions: detectedId
        ? [{ action: 'QUARANTINE', targetId: detectedId }]
        : [],
      report: [],
      scanPlan: [],
    },
  };
}

function evidenceCompare(
  focus: { jobId: string | null },
  tools: readonly EvidenceTool[],
): EvidenceDecision {
  const top = tools.find(
    (tool) => tool.name === 'get_top_risk_results' && tool.ok,
  );
  if (!top)
    return {
      kind: 'tools',
      name: 'get_top_risk_results',
      input: { jobId: focus.jobId, k: 10 },
    };
  const ids = arrayField(top.data, 'rows')
    .map((row) => textField(row, 'id'))
    .filter((id) => id !== '');
  const first = ids[0];
  const second = ids[1];
  const compared = tools.find(
    (tool) => tool.name === 'compare_results' && tool.ok,
  );
  if (!compared && first && second)
    return {
      kind: 'tools',
      name: 'compare_results',
      input: { resultIdA: first, resultIdB: second },
    };
  const data = isRecord(compared?.data) ? compared.data : {};
  const left = isRecord(data.a) ? data.a : {};
  const right = isRecord(data.b) ? data.b : {};
  return {
    kind: 'final',
    wire: {
      answer: compared
        ? `Comparación con compare_results. ${textField(left, 'fileName')} quedó ${textField(left, 'verdict')} con ${textField(left, 'engineScore')} puntos. ${textField(right, 'fileName')} quedó ${textField(right, 'verdict')} con ${textField(right, 'engineScore')} puntos. Mismo veredicto: ${data.sameVerdict === true ? 'sí' : 'no'}. Diferencia de puntuación: ${textField(data, 'scoreDelta')}.`
        : 'No hay dos detecciones con puntuación para comparar.',
      references: ids.slice(0, 2).map((id) => ({ type: 'result', id })),
      suggestedActions: [],
      report: [],
      scanPlan: [],
    },
  };
}

function evidenceReport(
  focus: { jobId: string | null },
  tools: readonly EvidenceTool[],
): EvidenceDecision {
  const built = tools.find((tool) => tool.name === 'build_report' && tool.ok);
  if (!built)
    return {
      kind: 'tools',
      name: 'build_report',
      input: {
        jobId: focus.jobId,
        zone: null,
        verdicts: ['DETECTED', 'SUSPICIOUS'],
        from: null,
        to: null,
      },
    };
  const data = isRecord(built.data) ? built.data : {};
  const cited = arrayField(data, 'results')
    .map((row) => textField(row, 'id'))
    .filter((id) => id !== '')
    .slice(0, 5);
  const draftId = textField(data, 'reportDraftId');
  return {
    kind: 'final',
    wire: {
      answer: `El Core calculó ${textField(data, 'total')} resultados detectados o sospechosos. Este resumen no cambia esas cifras.`,
      references: cited.map((id) => ({ type: 'result', id })),
      suggestedActions: draftId
        ? [{ action: 'EXPORT_REPORT', targetId: draftId }]
        : [],
      report: draftId
        ? [
            {
              reportDraftId: draftId,
              executiveSummary:
                'Resumen de demostración: las cifras salen de SQLite y esta redacción solo las acompaña.',
              conclusions: [
                'Conviene revisar cada archivo citado antes de tomar una acción.',
              ],
              citedResultIds: cited,
            },
          ]
        : [],
      scanPlan: [],
    },
  };
}

function evidenceLayers(
  focus: { resultId: string | null },
  tools: readonly EvidenceTool[],
): EvidenceDecision {
  if (!focus.resultId)
    return {
      kind: 'final',
      wire: {
        answer: 'Selecciona un archivo para consultar qué capa lo revisó.',
        references: [],
        suggestedActions: [],
        report: [],
        scanPlan: [],
      },
    };
  const report = tools.find(
    (tool) => tool.name === 'get_layer_report' && tool.ok,
  );
  if (!report)
    return {
      kind: 'tools',
      name: 'get_layer_report',
      input: { resultId: focus.resultId, jobId: null, zone: null },
    };
  const layers = arrayField(report.data, 'rows')
    .map((row) => `${textField(row, 'layer')} en ${textField(row, 'status')}`)
    .join(', ');
  return {
    kind: 'final',
    wire: {
      answer: layers
        ? `Según get_layer_report, estas capas revisaron el archivo: ${layers}.`
        : 'get_layer_report no devolvió capas para este archivo.',
      references: [{ type: 'result', id: focus.resultId }],
      suggestedActions: [],
      report: [],
      scanPlan: [],
    },
  };
}

function evidencePlan(tools: readonly EvidenceTool[]): EvidenceDecision {
  const zones = tools.find((tool) => tool.name === 'list_zones' && tool.ok);
  if (!zones) return { kind: 'tools', name: 'list_zones', input: {} };
  const rows = arrayField(zones.data, 'rows').filter(
    (row) => stringList(row, 'paths').length > 0,
  );
  const target =
    rows.find((row) => textField(row, 'zoneId') === 'EXTRAIBLE') ??
    rows.find((row) => textField(row, 'zoneId') === 'DESCARGAS') ??
    rows[0];
  if (!target)
    return {
      kind: 'final',
      wire: {
        answer: 'list_zones no devolvió una carpeta que se pueda escanear.',
        references: [],
        suggestedActions: [],
        report: [],
        scanPlan: [],
      },
    };
  const zoneId = textField(target, 'zoneId');
  const driveId = textField(target, 'driveId');
  const layers = [
    'HASH',
    'SIGNATURES',
    'FILETYPE',
    'RULES',
    'HEURISTICS',
    'PE',
    'SCRIPTS',
  ];
  return {
    kind: 'final',
    wire: {
      answer: driveId
        ? `Plan para la unidad ${driveId}. El escaneo no empieza hasta que confirmes Ejecutar plan.`
        : `No hay una unidad extraíble conectada. El plan usa la zona ${zoneId}, que sí devolvió list_zones. El escaneo no empieza hasta que confirmes.`,
      references: [{ type: 'zone', id: zoneId }],
      suggestedActions: [{ action: 'RUN_SCAN_PLAN', targetId: '' }],
      report: [],
      scanPlan: [
        {
          schema: 'cybersoc.scan-plan/v1',
          targets: [{ zoneId, driveId }],
          layers,
          includeHidden: true,
          maxFileSizeMB: 512,
          rationale:
            'Esta zona puede traer ejecutables y accesos directos. El escaneo solo empieza si la persona lo confirma.',
          layerRationale: layers.map((layer) => ({
            layer,
            why: `La capa ${layer} revisa esa parte del archivo.`,
          })),
        },
      ],
    },
  };
}

function evidenceQuestion(messages: readonly AssistantMessage[]): string {
  const marker = 'Pregunta del usuario:\n';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content;
    if (typeof content !== 'string') continue;
    const at = content.lastIndexOf(marker);
    if (at >= 0) return content.slice(at + marker.length).trim();
  }
  return '';
}

function evidenceFocus(messages: readonly AssistantMessage[]): {
  resultId: string | null;
  jobId: string | null;
} {
  const empty = { resultId: null, jobId: null };
  const text = [...messages]
    .reverse()
    .find((message) => typeof message.content === 'string')?.content;
  if (typeof text !== 'string') return empty;
  const json = text.match(/<contexto>\n([\s\S]*?)\n<\/contexto>/)?.[1];
  try {
    const focus = JSON.parse(json ?? '') as {
      kind?: string;
      result?: { file?: { resultId?: string } };
      job?: { job?: { jobId?: string } };
    };
    return {
      resultId: focus.result?.file?.resultId ?? null,
      jobId: focus.job?.job?.jobId ?? null,
    };
  } catch {
    return empty;
  }
}

function evidenceToolPayloads(
  messages: readonly AssistantMessage[],
): EvidenceTool[] {
  const names = new Map<string, string>();
  const found: EvidenceTool[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') names.set(block.id, block.name);
      if (block.type !== 'tool_result') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.content);
      } catch {
        continue;
      }
      const record = isRecord(parsed) ? parsed : {};
      found.push({
        name: names.get(block.tool_use_id) ?? '',
        ok: record.ok === true,
        data: record.data,
      });
    }
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arrayField(data: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(data) || !Array.isArray(data[key])) return [];
  return data[key].filter(isRecord);
}

function stringList(row: Record<string, unknown>, key: string): string[] {
  const value = row[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function textField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function evidenceAssistantText(json: string | undefined): string {
  let evidence = 'sin evidencias en el foco';
  let layers = 'sin traza de capas';
  try {
    const focus = JSON.parse(json ?? '') as {
      kind?: string;
      result?: {
        evidence?: { id?: string; code?: string; source?: string }[];
        layers?: { layer?: string; status?: string }[];
      };
    };
    if (focus.kind === 'RESULT') {
      const items = focus.result?.evidence ?? [];
      if (items.length > 0) {
        evidence = items
          .map((item) => `${item.id} (${item.code}, origen ${item.source})`)
          .join('; ');
      }
      const trace = focus.result?.layers ?? [];
      if (trace.length > 0) {
        layers = trace
          .map((item) => `capa ${item.layer} (${item.status})`)
          .join(', ');
      }
    }
  } catch {
    evidence = 'no se pudo leer el foco';
  }
  return (
    'Demostración con FakeAIProvider. El archivo fue marcado según los datos del escaneo. ' +
    `Evidencias citadas: ${evidence}. Capas: ${layers}. ` +
    'Esta explicación usa solo esos datos y no cambia el veredicto.'
  );
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
          ? decideRisk({
              verdict,
              score: result.score,
              userAllowlisted: new AllowlistRepository(database).has(
                record.sha256,
              ),
            })
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

/** Main es el único adaptador que puede solicitar confirmación. No existe disparo automático. */
export function createQuarantineManager(
  database: Database,
  confirm?: QuarantineOptions['confirm'],
): QuarantineManager {
  const userData = app.getPath('userData');
  const local = process.env.LOCALAPPDATA;
  const vaultPath =
    process.env.CYBERSOC_EVIDENCE_MODE === '1'
      ? join(userData, 'quarantine')
      : join(
          local ?? userData,
          ...(local ? ['CyberSOC Defender'] : []),
          'quarantine',
        );
  return new QuarantineManager({
    database,
    vault: new QuarantineVault(vaultPath),
    protectedPaths: new ProtectedPaths([
      userData,
      vaultPath,
      app.getAppPath(),
      dirname(process.execPath),
    ]),
    confirm:
      confirm ??
      (async (request) => {
        const labels = {
          QUARANTINE: 'Poner en cuarentena',
          RESTORE: 'Restaurar',
          RESTORE_DETECTED: 'Confirmar restauración de archivo detectado',
          DELETE: 'Eliminar definitivamente',
        };
        const answer = await dialog.showMessageBox({
          type: 'warning',
          title: labels[request.action],
          message: `${labels[request.action]}: ${request.path}`,
          detail:
            `Veredicto: ${request.verdict}.` +
            (request.trustHash ? ' También confiarás en este SHA-256.' : ''),
          buttons: ['Cancelar', labels[request.action]],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return answer.response === 1;
      }),
  });
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
