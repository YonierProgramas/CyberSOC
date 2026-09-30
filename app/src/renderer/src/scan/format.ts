import type {
  ScanJobDTO,
  ScanJobStatus,
  ScanResultDTO,
} from '../../../shared/ipc';

export const PAGE_SIZE = 200;

export interface ScanMetrics {
  peakStackSize: number | null;
  peakQueueSize: number | null;
  producerBlockedMs: number | null;
  totalDurationMs: number | null;
}

const emptyMetrics: ScanMetrics = {
  peakStackSize: null,
  peakQueueSize: null,
  producerBlockedMs: null,
  totalDurationMs: null,
};

export function fileNameOf(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function formatBytes(size: number | null): string {
  if (size === null) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} min ${rest} s`;
}

export function shortHash(hash: string): string {
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

export function resultStatusLabel(status: ScanResultDTO['status']): string {
  if (status === 'SCANNED') return 'Analizado';
  if (status === 'ERROR') return 'Error';
  return 'Omitido';
}

export function jobStatusLabel(status: ScanJobStatus): string {
  const labels: Record<ScanJobStatus, string> = {
    CREATED: 'Creado',
    DISCOVERING: 'Descubriendo',
    SCANNING: 'Analizando',
    CANCELLING: 'Cancelando',
    CANCELLED: 'Cancelado',
    COMPLETED: 'Completado',
    FAILED: 'Fallido',
  };
  return labels[status];
}

export function verdictLabel(): string {
  return 'Sin evaluar';
}

export function readMetrics(metricsJson: string | null): ScanMetrics {
  if (!metricsJson) return emptyMetrics;
  try {
    const value: unknown = JSON.parse(metricsJson);
    if (!value || typeof value !== 'object') return emptyMetrics;
    const record = value as Record<string, unknown>;
    const numberOrNull = (key: string) =>
      typeof record[key] === 'number' ? record[key] : null;
    return {
      peakStackSize: numberOrNull('peakStackSize'),
      peakQueueSize: numberOrNull('peakQueueSize'),
      producerBlockedMs: numberOrNull('producerBlockedMs'),
      totalDurationMs: numberOrNull('totalDurationMs'),
    };
  } catch {
    return emptyMetrics;
  }
}

export function jobDuration(
  job: ScanJobDTO,
  elapsedMs: number | null,
): number | null {
  const metrics = readMetrics(job.metricsJson);
  if (metrics.totalDurationMs !== null) return metrics.totalDurationMs;
  if (job.startedAt && job.finishedAt) {
    const duration = Date.parse(job.finishedAt) - Date.parse(job.startedAt);
    return Number.isFinite(duration) ? duration : elapsedMs;
  }
  return elapsedMs;
}
