import type { EngineResult, Zone } from './protocol';
import type { ScanProfileChoice } from './scan-profile';

// Serializable boundary types intentionally do not import the Node/Electron core.
export type ScanJobStatus =
  | 'CREATED'
  | 'DISCOVERING'
  | 'SCANNING'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'FAILED';
export interface ScanTarget {
  kind: 'FILE' | 'FOLDER';
  path: string;
  profile?: ScanProfileChoice;
}
export interface ScanJobDTO {
  id: string;
  targetPath: string;
  targetKind: 'FILE' | 'FOLDER';
  status: ScanJobStatus;
  filesDiscovered: number;
  filesProcessed: number;
  filesError: number;
  filesSkipped: number;
  bytesProcessed: number;
  engineVersion: string | null;
  protocolVersion: string | null;
  rulesetVersion: string | null;
  signaturesVersion: string | null;
  profileJson: string | null;
  metricsJson: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ScanResultDTO {
  id: string;
  jobId: string;
  seq: number;
  path: string;
  fileName: string;
  extension: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  status: EngineResult['status'];
  sha256: string | null;
  verdict:
    'NOT_EVALUATED' | 'CLEAN' | 'SUSPICIOUS' | 'DETECTED' | 'NOT_ANALYZED';
  errorCode: NonNullable<EngineResult['error']>['code'] | null;
  errorMessage: string | null;
  durationMs: number | null;
  scannedAt: string;
  engineScore: number | null;
  riskLevel: 'BAJO' | 'MEDIO' | 'ALTO' | 'CRÍTICO' | null;
  aiStatus: AIStatus;
  zone: Zone | null;
}
export interface ScanProgress {
  jobId: string;
  status: ScanJobStatus;
  discovered: number;
  processed: number;
  errors: number;
  skipped: number;
  discoveryDone: boolean;
  percent: number | null;
  currentPath?: string;
  elapsedMs: number;
}
export interface Page<T> {
  items: T[];
  offset: number;
  limit: number;
  total: number;
}
export interface ScanResultsQuery {
  jobId: string;
  offset: number;
  limit: number;
}

export const SYSTEM_GET_STATUS = 'system:getStatus';
export const SYSTEM_RECONNECT_ENGINE = 'system:reconnectEngine';
export const DIALOG_SELECT_FOLDER = 'dialog:selectFolder';
export const DIALOG_SELECT_FILE = 'dialog:selectFile';
export const SCAN_START = 'scan:start';
export const SCAN_CANCEL = 'scan:cancel';
export const SCAN_GET_JOB = 'scan:getJob';
export const SCAN_LIST_JOBS = 'scan:listJobs';
export const SCAN_LIST_RESULTS = 'scan:listResults';
export const SCAN_PROGRESS = 'scan:progress';
export const SCAN_FINISHED = 'scan:finished';
export const SCAN_GET_RESULT = 'scan:getResult';
export const SCAN_GET_JOB_SUMMARY = 'scan:getJobSummary';
export const SCAN_ANALYZE_NOW = 'scan:analyzeNow';
export const AI_RESULT_UPDATED = 'ai:resultUpdated';

export type AIStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'RUNNING'
  | 'RETRY_WAIT'
  | 'COMPLETED'
  | 'UNAVAILABLE'
  | 'INVALID'
  | 'NOT_CONFIGURED';

export interface EvidenceView {
  id: string;
  source: string;
  code: string;
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  points: number;
}

export interface LayerView {
  layer: string;
  status: 'RAN' | 'SKIPPED' | 'DISABLED' | 'ERROR';
  reason: string | null;
  hits: number;
  points: number;
}

export interface AICorrelationView {
  evidenceIds: string[];
  insight: string;
}

export interface AIAnalysisView {
  summary: string;
  plainExplanation: string;
  technicalAnalysis: string;
  correlations: AICorrelationView[];
  recommendedAction: string;
  actionRationale: string;
}

export interface AISentView {
  contextJson: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  validationStatus: string;
}

export interface DecisionView {
  origin: 'ENGINE' | 'AI_ESCALATION' | 'USER_ALLOWLIST';
  policyVersion: string;
  rule: string | null;
  trace: string[];
}

export interface JobSummaryHighlight {
  resultId: string;
  why: string;
}

export interface JobSummaryView {
  state: 'PENDING' | 'COMPLETED' | 'UNAVAILABLE' | 'INVALID';
  summary: string | null;
  highlights: JobSummaryHighlight[];
  recommendations: string[];
}

export interface ResultDetailDTO {
  result: ScanResultDTO;
  evidence: EvidenceView[];
  layers: LayerView[];
  decision: DecisionView | null;
  analysis: AIAnalysisView | null;
  sent: AISentView | null;
}

export interface AIResultUpdated {
  resultId: string;
  aiStatus: AIStatus;
}
export const ASSISTANT_ASK = 'assistant:ask';
export const ASSISTANT_RESET = 'assistant:reset';
/** Longitud máxima de la pregunta del usuario al Copilot. */
export const ASSISTANT_MESSAGE_MAX_CHARS = 2_000;

export interface AssistantAskQuery {
  message: string;
  /** Resultado o escaneo seleccionado (solo uno). Sin foco, responde en términos generales. */
  focus?: { resultId?: string; jobId?: string };
}

export interface AssistantFocusDTO {
  kind: 'NONE' | 'RESULT' | 'JOB';
  id: string | null;
  /** Nombre del archivo o ruta del escaneo, para "Hablando de: …". */
  label: string | null;
}

export interface AssistantReplyDTO {
  /** ANSWERED: respuesta de la IA. UNAVAILABLE: la IA falló o no está configurada. CANCELLED: hubo "Nueva conversación". */
  status: 'ANSWERED' | 'UNAVAILABLE' | 'CANCELLED';
  /** Respuesta o mensaje claro para el usuario. Siempre se muestra como texto plano. */
  text: string;
  errorKind:
    | 'NOT_CONFIGURED'
    | 'OFFLINE'
    | 'TIMEOUT'
    | 'RATE_LIMIT'
    | 'AUTH'
    | 'PROVIDER_DOWN'
    | 'INVALID_OUTPUT'
    | 'INCOMPLETE'
    | 'UNSAFE'
    | null;
  focus: AssistantFocusDTO;
  /** Turnos guardados en la ventana del historial después de esta pregunta (máximo 10). */
  historyTurns: number;
}

export const SETTINGS_AI_SET_API_KEY = 'settings.ai:setApiKey';
export const SETTINGS_AI_CLEAR_API_KEY = 'settings.ai:clearApiKey';
export const SETTINGS_AI_GET_STATUS = 'settings.ai:getStatus';
export const SETTINGS_AI_TEST_CONNECTION = 'settings.ai:testConnection';

export interface AISettingsStatus {
  configured: boolean;
  last4: string | null;
  model: string;
}

export type AIHealthCheck =
  | {
      ok: true;
      value: { model: string };
      model: string;
      usage: { inputTokens: number; outputTokens: number };
      latencyMs: number;
    }
  | {
      ok: false;
      error: {
        kind:
          | 'OFFLINE'
          | 'TIMEOUT'
          | 'RATE_LIMIT'
          | 'AUTH'
          | 'PROVIDER_DOWN'
          | 'INVALID_OUTPUT'
          | 'INCOMPLETE'
          | 'UNSAFE';
        retryable: boolean;
        retryAfterMs?: number;
        message: string;
      };
    };

export type EngineState =
  | { status: 'connected'; engineVersion: string; protocol: '1' }
  | { status: 'disconnected'; engineVersion: null; protocol: null }
  | {
      status: 'incompatible';
      engineVersion: string | null;
      protocol: string | null;
    };

export interface SystemStatus {
  app: 'CyberSOC Defender';
  version: string;
  engine: EngineState;
}

export interface CyberSocApi {
  readonly settings: {
    readonly ai: {
      readonly setApiKey: (key: string) => Promise<void>;
      readonly clearApiKey: () => Promise<void>;
      readonly getStatus: () => Promise<AISettingsStatus>;
      readonly testConnection: () => Promise<AIHealthCheck>;
    };
  };
  readonly dialog: {
    readonly selectFolder: () => Promise<string | null>;
    readonly selectFile: () => Promise<string | null>;
  };
  readonly scan: {
    readonly start: (target: ScanTarget) => Promise<{ jobId: string }>;
    readonly cancel: (jobId: string) => Promise<void>;
    readonly getJob: (jobId: string) => Promise<ScanJobDTO>;
    readonly listJobs: (limit?: number) => Promise<ScanJobDTO[]>;
    readonly listResults: (
      query: ScanResultsQuery,
    ) => Promise<Page<ScanResultDTO>>;
    readonly getResult: (resultId: string) => Promise<ResultDetailDTO>;
    readonly getJobSummary: (jobId: string) => Promise<JobSummaryView>;
    readonly analyzeNow: (resultId: string) => Promise<void>;
    readonly onProgress: (
      callback: (progress: ScanProgress) => void,
    ) => () => void;
    readonly onFinished: (callback: (job: ScanJobDTO) => void) => () => void;
    readonly onResultUpdated: (
      callback: (update: AIResultUpdated) => void,
    ) => () => void;
  };
  readonly system: {
    readonly getStatus: () => Promise<SystemStatus>;
    readonly reconnectEngine: () => Promise<SystemStatus>;
  };
  readonly assistant: {
    readonly ask: (query: AssistantAskQuery) => Promise<AssistantReplyDTO>;
    readonly reset: () => Promise<void>;
  };
}
