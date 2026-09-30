import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { Database } from '../../core/persistence/Database';
import { aiAssessmentSchema } from '../../core/ai/schemas';
import { AIAnalysisRepository } from '../../core/persistence/AIAnalysisRepository';
import { EvidenceRepository } from '../../core/persistence/EvidenceRepository';
import { LayerTraceRepository } from '../../core/persistence/LayerTraceRepository';
import { ScanJobRepository } from '../../core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../../core/persistence/ScanResultRepository';
import type { ScanOrchestrator } from '../../core/scan/ScanOrchestrator';
import {
  AI_RESULT_UPDATED,
  SCAN_ANALYZE_NOW,
  SCAN_START,
  SCAN_CANCEL,
  SCAN_GET_JOB,
  SCAN_GET_RESULT,
  SCAN_LIST_JOBS,
  SCAN_LIST_RESULTS,
  SCAN_PROGRESS,
  SCAN_FINISHED,
  type AIResultUpdated,
  type ResultDetailDTO,
  type ScanJobDTO,
  type ScanResultDTO,
  type Page,
  type ScanProgress,
} from '../../shared/ipc';
import {
  existingScanTarget,
  requireTrustedSender,
  scanTargetSchema,
  trustedWindow,
} from './scan-validation';

const idSchema = z.string().min(1);
const startArguments = z.tuple([scanTargetSchema]);
const idArguments = z.tuple([idSchema]);
const listArguments = z.union([z.tuple([]), z.tuple([z.int().min(0)])]);
const pageArguments = z.tuple([
  z.strictObject({
    jobId: idSchema,
    offset: z.int().min(0),
    limit: z.int().min(1).max(200),
  }),
]);

export interface AIAnalysisControl {
  analyzeNow(resultId: string): void;
  on(
    event: 'ai:resultUpdated',
    listener: (update: AIResultUpdated) => void,
  ): void;
  off(
    event: 'ai:resultUpdated',
    listener: (update: AIResultUpdated) => void,
  ): void;
}

export function registerScanIpc(
  getWindow: () => BrowserWindow | null,
  trustedRendererUrl: string,
  orchestrator: ScanOrchestrator,
  database: Database,
  ai?: AIAnalysisControl,
): () => Promise<void> {
  let disposed = false;
  let activeJobId: string | null = null;
  const jobs = new ScanJobRepository(database);
  const results = new ScanResultRepository(database);
  // Count the persisted rows rather than inferring total from a possibly interrupted counter update.
  const count = database.prepare(
    'SELECT COUNT(*) AS total FROM scan_results WHERE job_id = ?',
  );
  const validate = (event: IpcMainInvokeEvent) =>
    requireTrustedSender(getWindow, trustedRendererUrl, event);
  const getJob = (id: string): ScanJobDTO => {
    const job = jobs.get(id);
    if (!job) throw new Error('No existe el trabajo de escaneo.');
    return job;
  };

  ipcMain.handle(
    SCAN_START,
    async (event, ...args: unknown[]): Promise<{ jobId: string }> => {
      validate(event);
      const [input] = startArguments.parse(args);
      const target = await existingScanTarget(input);
      validate(event);
      if (disposed) throw new Error('El IPC de escaneo se está cerrando.');
      const jobId = orchestrator.start(target);
      activeJobId = jobId;
      return { jobId };
    },
  );
  ipcMain.handle(
    SCAN_CANCEL,
    async (event, ...args: unknown[]): Promise<void> => {
      validate(event);
      const [id] = idArguments.parse(args);
      await orchestrator.cancel(id);
    },
  );
  ipcMain.handle(SCAN_GET_JOB, (event, ...args: unknown[]): ScanJobDTO => {
    validate(event);
    const [id] = idArguments.parse(args);
    return getJob(id);
  });
  ipcMain.handle(SCAN_LIST_JOBS, (event, ...args: unknown[]): ScanJobDTO[] => {
    validate(event);
    const [limit] = listArguments.parse(args);
    return jobs.listRecent(limit);
  });
  ipcMain.handle(
    SCAN_LIST_RESULTS,
    (event, ...args: unknown[]): Page<ScanResultDTO> => {
      validate(event);
      const [query] = pageArguments.parse(args);
      getJob(query.jobId);
      return {
        items: results.listByJob(query.jobId, query.offset, query.limit),
        offset: query.offset,
        limit: query.limit,
        total: Number(count.get(query.jobId)!.total),
      };
    },
  );
  ipcMain.handle(
    SCAN_GET_RESULT,
    (event, ...args: unknown[]): ResultDetailDTO => {
      validate(event);
      const [id] = idArguments.parse(args);
      return resultDetail(database, id);
    },
  );
  ipcMain.handle(SCAN_ANALYZE_NOW, (event, ...args: unknown[]): void => {
    validate(event);
    const [id] = idArguments.parse(args);
    if (!ai) throw new Error('El análisis de IA no está disponible.');
    ai.analyzeNow(id);
  });

  const progress = (value: ScanProgress) =>
    trustedWindow(getWindow, trustedRendererUrl)?.webContents.send(
      SCAN_PROGRESS,
      value,
    );
  const finished = (value: ScanJobDTO) => {
    if (activeJobId === value.id) activeJobId = null;
    trustedWindow(getWindow, trustedRendererUrl)?.webContents.send(
      SCAN_FINISHED,
      value,
    );
  };
  const updated = (value: AIResultUpdated) =>
    trustedWindow(getWindow, trustedRendererUrl)?.webContents.send(
      AI_RESULT_UPDATED,
      value,
    );
  orchestrator.on('progress', progress);
  orchestrator.on('finished', finished);
  ai?.on('ai:resultUpdated', updated);
  return async () => {
    if (disposed) return;
    disposed = true;
    orchestrator.off('progress', progress);
    orchestrator.off('finished', finished);
    ai?.off('ai:resultUpdated', updated);
    for (const channel of [
      SCAN_START,
      SCAN_CANCEL,
      SCAN_GET_JOB,
      SCAN_GET_RESULT,
      SCAN_ANALYZE_NOW,
      SCAN_LIST_JOBS,
      SCAN_LIST_RESULTS,
    ])
      ipcMain.removeHandler(channel);
    if (activeJobId !== null) await orchestrator.cancel(activeJobId);
  };
}

function readAnalysis(
  validationStatus: string | undefined,
  responseJson: string | null | undefined,
): ResultDetailDTO['analysis'] {
  if (validationStatus !== 'VALID' || !responseJson) return null;
  try {
    const parsed = aiAssessmentSchema.safeParse(JSON.parse(responseJson));
    if (!parsed.success) return null;
    return {
      summary: parsed.data.summary,
      plainExplanation: parsed.data.plainExplanation,
      technicalAnalysis: parsed.data.technicalAnalysis,
      correlations: parsed.data.correlations.map((item) => ({
        evidenceIds: [...item.evidenceIds],
        insight: item.insight,
      })),
      recommendedAction: parsed.data.recommendedAction,
      actionRationale: parsed.data.actionRationale,
    };
  } catch {
    return null;
  }
}

function resultDetail(database: Database, id: string): ResultDetailDTO {
  const result = new ScanResultRepository(database).get(id);
  if (!result) throw new Error('No existe el resultado de escaneo.');
  const attempt = new AIAnalysisRepository(database).latestByResult(id);
  const analysis = readAnalysis(
    attempt?.validationStatus,
    attempt?.responseJson,
  );
  return {
    result,
    evidence: new EvidenceRepository(database).listByResult(id).map((item) => ({
      id: item.evidenceKey,
      source: item.source,
      code: item.code,
      severity: item.severity,
      points: item.points,
    })),
    layers: new LayerTraceRepository(database).listByResult(id).map((item) => ({
      layer: item.layer,
      status: item.status,
      reason: item.reason,
      hits: item.hits,
      points: item.points,
    })),
    analysis,
    sent: attempt
      ? {
          contextJson: attempt.contextJson,
          model: attempt.model,
          inputTokens: attempt.inputTokens,
          outputTokens: attempt.outputTokens,
          latencyMs: attempt.latencyMs,
          validationStatus: attempt.validationStatus,
        }
      : null,
  };
}
