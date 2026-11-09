import type { z } from 'zod';
import type { EngineResult, Zone } from './protocol';
import type { ScanProfile, ScanProfileChoice } from './scan-profile';

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
  /** Top 10 by engine score, descending and stable by arrival.
   * Only SCANNED results with a score; it does not reflect later AI/allowlist changes.
   */
  topRisk: Array<{
    resultId: string;
    path: string;
    fileName: string;
    engineScore: number;
  }>;
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
export const ASSISTANT_LIST_CONVERSATIONS = 'assistant:listConversations';
export const ASSISTANT_OPEN_CONVERSATION = 'assistant:openConversation';

export interface ConversationQuery {
  limit?: number;
  offset?: number;
}

export interface ConversationDTO {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageDTO {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallsJson: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

export interface OpenConversationDTO {
  conversation: ConversationDTO;
  /** Messages of the last 10 turns; the complete history stays in SQLite. */
  messages: ConversationMessageDTO[];
  historyTurns: number;
}
/** Maximum length of the user question to the Copilot. */
export const ASSISTANT_MESSAGE_MAX_CHARS = 2_000;

export interface AssistantAskQuery {
  message: string;
  /** Selected result or scan (only one). Without focus, it answers in general terms. */
  focus?: { resultId?: string; jobId?: string };
}

export interface AssistantFocusDTO {
  kind: 'NONE' | 'RESULT' | 'JOB';
  id: string | null;
  /** File name or scan path, for "Hablando de: …". */
  label: string | null;
}

export interface AssistantReplyDTO {
  /** ANSWERED: AI response. UNAVAILABLE: the AI failed or is not configured. CANCELLED: there was a "Nueva conversación". */
  status: 'ANSWERED' | 'UNAVAILABLE' | 'CANCELLED';
  /** Response or clear message for the user. Always displayed as plain text. */
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
    | 'TOOL_LIMIT'
    | null;
  focus: AssistantFocusDTO;
  /** Turns stored in the history window after this question (at most 10). */
  historyTurns: number;
  /** Chips: real cited IDs (S5). Already validated by the Core. */
  references: AssistantReferenceDTO[];
  /** Buttons: each action requires user confirmation in the UI. */
  suggestedActions: AssistantActionDTO[];
  /** Report card: Core figures + wording labeled "Generado por IA". */
  report: AssistantReportCardDTO | null;
  /** Scan plan card: NEVER runs without "Ejecutar plan" + confirmation. */
  scanPlan: ScanPlanCardDTO | null;
  /** Read-only tools the AI queried for this question. */
  toolCalls: AssistantToolCallDTO[];
  /** Reasons (from the Core) why the final response was discarded, if it was. */
  rejected: string[];
}

export interface AssistantReferenceDTO {
  type: 'result' | 'job' | 'rule' | 'zone';
  id: string;
}

export interface AssistantActionDTO {
  action:
    | 'OPEN_RESULT'
    | 'QUARANTINE'
    | 'ANALYZE_WITH_AI'
    | 'OPEN_QUARANTINE'
    | 'EXPORT_REPORT'
    | 'RUN_SCAN_PLAN';
  targetId: string | null;
}

export interface AssistantReportCardDTO {
  reportDraftId: string;
  /** Figures computed by the Core from SQLite, never by the AI. */
  total: number;
  verdicts: { verdict: string; count: number }[];
  executiveSummary: string;
  conclusions: string[];
  citedResultIds: string[];
  label: 'Generado por IA';
}

export interface ScanPlanCardDTO {
  schema: 'cybersoc.scan-plan/v1';
  targets: {
    zoneId: Zone;
    driveId: string | null;
    paths: string[];
  }[];
  profile: ScanProfile;
  rationale: string;
  layerRationale: { layer: ScanProfile['layers'][number]; why: string }[];
}

export interface AssistantToolCallDTO {
  name: string;
  ok: boolean;
  /** Tool error code (UNKNOWN_TOOL, INVALID_ARGUMENTS…) or null. */
  code: string | null;
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
  readonly dashboard: {
    readonly getOverview: (
      query?: DashboardOverviewQuery,
    ) => Promise<DashboardOverviewDTO>;
  };
  readonly reports: {
    readonly export: (query: ReportExportQuery) => Promise<ReportExportResult>;
  };
  readonly quarantine: {
    readonly list: (query?: QuarantineQuery) => Promise<QuarantineItemDTO[]>;
    /** Invoke only after explicit confirmation in the UI. */
    readonly quarantine: (resultId: string) => Promise<QuarantineItemDTO>;
    readonly restore: (
      itemId: string,
      options: QuarantineRestoreOptions,
    ) => Promise<QuarantineItemDTO>;
    readonly delete: (itemId: string) => Promise<void>;
    readonly onChanged: (
      callback: (change: QuarantineChanged) => void,
    ) => () => void;
  };
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
    readonly listJobsPage: (
      query: ScanJobsPageQuery,
    ) => Promise<Page<ScanJobDTO>>;
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
    readonly listConversationsPage: (
      query: ConversationPageQuery,
    ) => Promise<Page<ConversationSummaryDTO>>;
    readonly listMessages: (
      query: ConversationMessagesQuery,
    ) => Promise<ConversationMessagesPageDTO>;
    readonly ask: (query: AssistantAskQuery) => Promise<AssistantReplyDTO>;
    readonly reset: () => Promise<void>;
    readonly listConversations: (
      query?: ConversationQuery,
    ) => Promise<ConversationDTO[]>;
    readonly openConversation: (id: string) => Promise<OpenConversationDTO>;
  };
}

export const REPORTS_EXPORT = 'reports:export';
export interface ReportExportQuery {
  reportDraftId: string;
  format: 'html' | 'csv' | 'json';
}
export interface ReportExportResult {
  status: 'SAVED' | 'CANCELLED';
}

export const QUARANTINE_LIST = 'quarantine:list';
export const QUARANTINE_QUARANTINE = 'quarantine:quarantine';
export const QUARANTINE_RESTORE = 'quarantine:restore';
export const QUARANTINE_DELETE = 'quarantine:delete';
export const QUARANTINE_CHANGED = 'quarantine:changed';

// The factory avoids loading Zod in the sandboxed preload: only channels and types are imported there.
export function createQuarantineSchemas(z: typeof import('zod').z) {
  const quarantineStatusSchema = z.enum([
    'PENDING',
    'QUARANTINED',
    'RESTORED',
    'DELETED',
    'FAILED',
  ]);
  const quarantineIdSchema = z
    .string()
    .min(1)
    .max(256)
    .refine((id) => id.trim() === id && !id.includes('\0'));
  const quarantineQuerySchema = z.strictObject({
    status: quarantineStatusSchema.optional(),
  });
  const quarantineRestoreOptionsSchema = z.strictObject({
    trustHash: z.boolean(),
    // Path normalization and safety are checked in the manager.
    targetPath: z
      .string()
      .min(1)
      .max(32767)
      .refine((path) => !path.includes('\0'))
      .optional(),
  });
  const quarantineListArgumentsSchema = z.union([
    z.tuple([]),
    z.tuple([quarantineQuerySchema.optional()]),
  ]);
  const quarantineIdArgumentsSchema = z.tuple([quarantineIdSchema]);
  const quarantineRestoreArgumentsSchema = z.tuple([
    quarantineIdSchema,
    quarantineRestoreOptionsSchema,
  ]);

  // Explicit list of public fields: never serialize complete SQLite records.
  const quarantineItemSchema = z.strictObject({
    id: quarantineIdSchema,
    resultId: quarantineIdSchema.nullable(),
    originalPath: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    sizeBytes: z.number().int().nonnegative(),
    reason: z.string(),
    verdictSnapshot: z.string(),
    status: quarantineStatusSchema,
    quarantinedAt: z.string().nullable(),
    restoredAt: z.string().nullable(),
    restoredTo: z.string().nullable(),
    deletedAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
  });
  return {
    status: quarantineStatusSchema,
    query: quarantineQuerySchema,
    restoreOptions: quarantineRestoreOptionsSchema,
    listArguments: quarantineListArgumentsSchema,
    idArguments: quarantineIdArgumentsSchema,
    restoreArguments: quarantineRestoreArgumentsSchema,
    item: quarantineItemSchema,
  };
}
type QuarantineSchemas = ReturnType<typeof createQuarantineSchemas>;
export type QuarantineStatus = z.infer<QuarantineSchemas['status']>;
export type QuarantineQuery = z.infer<QuarantineSchemas['query']>;
export type QuarantineRestoreOptions = z.infer<
  QuarantineSchemas['restoreOptions']
>;
export type QuarantineItemDTO = z.infer<QuarantineSchemas['item']>;
/** Invalidation to query the list again, even if an operation left FAILED. */
export interface QuarantineChanged {
  itemId: string | null;
  resultId: string | null;
}

// Annex D: additions independent of the earlier contracts.
export const DASHBOARD_GET_OVERVIEW = 'dashboard:getOverview';
export const SCAN_LIST_JOBS_PAGE = 'scan:listJobsPage';
export const ASSISTANT_LIST_CONVERSATIONS_PAGE =
  'assistant:listConversationsPage';
export const ASSISTANT_LIST_MESSAGES = 'assistant:listMessages';
export const ASSISTANT_CARD_SCHEMA_V1 = 'cybersoc.assistant-card/v1';
export const ASSISTANT_CARD_MAX_BYTES = 2 * 1024 * 1024;
export const ASSISTANT_PAGE_MAX_CARD_BYTES = 8 * 1024 * 1024;

export interface DashboardOverviewQuery {
  from?: string;
  to?: string;
}
export type DashboardScope = 'LAST_COMPLETED' | 'ALL_COMPLETED' | 'RANGE';
export interface VerdictDistributionDTO {
  scope: DashboardScope;
  jobStatuses: ScanJobStatus[];
  range: { from: string; to: string } | null;
  jobs: number;
  results: {
    total: number;
    byVerdict: Record<ScanResultDTO['verdict'], number>;
    byStatus: Record<ScanResultDTO['status'], number>;
    byZone: { zone: Zone | null; results: number }[];
    byAiStatus: Record<AIStatus, number>;
  };
  excluded: {
    jobs: number;
    results: number;
    byJobStatus: Record<ScanJobStatus, number>;
  };
  partial: boolean;
}
export interface DashboardOverviewDTO {
  schema: 'cybersoc.dashboard/v1';
  generatedAt: string;
  timezone: string;
  range: { from: string; to: string; days: number };
  activity: {
    jobs: { total: number; byStatus: Record<ScanJobStatus, number> };
    daily: {
      date: string;
      jobs: number;
      results: number;
      detected: number;
      suspicious: number;
      errors: number;
    }[];
  };
  distributions: {
    lastCompleted: (VerdictDistributionDTO & { job: ScanJobDTO }) | null;
    allCompleted: VerdictDistributionDTO;
    range: VerdictDistributionDTO;
  };
  active: ScanJobDTO | null;
  quarantine: Record<QuarantineStatus, number>;
  allTime: {
    jobs: number;
    results: number;
    firstJobAt: string | null;
    byJobStatus: Record<ScanJobStatus, number>;
  };
}
export interface ScanJobsPageQuery {
  offset: number;
  limit: number;
  statuses?: ScanJobStatus[];
  from?: string;
  to?: string;
}
export interface ConversationPageQuery {
  offset: number;
  limit: number;
}
export interface ConversationSummaryDTO extends ConversationDTO {
  messageCount: number;
  lastMessageAt: string | null;
}
export interface ConversationMessagesQuery {
  conversationId: string;
  before?: string;
  limit?: number;
}
export interface AssistantCardV1 {
  schema: typeof ASSISTANT_CARD_SCHEMA_V1;
  focus: AssistantFocusDTO;
  references: AssistantReferenceDTO[];
  suggestedActions: AssistantActionDTO[];
  report: AssistantReportCardDTO | null;
  scanPlan: ScanPlanCardDTO | null;
}
export type ArchivedCardState = 'RECORDED' | 'NOT_RECORDED' | 'OMITTED';
export type ArchivedActionAvailability =
  'AVAILABLE' | 'MISSING' | 'NOT_APPLICABLE' | 'EXPIRED' | 'HISTORY_READ_ONLY';
export interface ArchivedActionStateDTO {
  index: number;
  action: AssistantActionDTO['action'];
  targetId: string | null;
  availability: ArchivedActionAvailability;
}
export type ConversationHistoryItemDTO =
  | {
      kind: 'USER';
      id: string;
      createdAt: string;
      text: string;
      answered: boolean;
    }
  | {
      kind: 'ASSISTANT';
      id: string;
      createdAt: string;
      text: string;
      model: string | null;
      cardState: ArchivedCardState;
      card: AssistantCardV1 | null;
      actionStates: ArchivedActionStateDTO[];
    }
  | {
      kind: 'TOOLS';
      id: string;
      createdAt: string;
      tools: AssistantToolCallDTO[];
    };
export interface ConversationMessagesPageDTO {
  conversationId: string;
  items: ConversationHistoryItemDTO[];
  olderCursor: string | null;
  total: number;
}
