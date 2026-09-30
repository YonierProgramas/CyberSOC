import type { EngineResult } from './protocol';

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
    readonly onProgress: (
      callback: (progress: ScanProgress) => void,
    ) => () => void;
    readonly onFinished: (callback: (job: ScanJobDTO) => void) => () => void;
  };
  readonly system: {
    readonly getStatus: () => Promise<SystemStatus>;
    readonly reconnectEngine: () => Promise<SystemStatus>;
  };
}
