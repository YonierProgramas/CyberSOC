import { useEffect } from 'react';

/** El aviso más reciente que el historial todavía no ha leído. */
export type ScanRefreshNotice =
  | { kind: 'progress'; jobId: string }
  | { kind: 'finished'; jobId: string }
  | { kind: 'result' };

/**
 * Un análisis que termina no debe perderse detrás de un progreso anterior.
 * Un cambio de resultado no sustituye el id del análisis que acaba de llegar.
 */
function prefer(
  current: ScanRefreshNotice,
  next: ScanRefreshNotice,
): ScanRefreshNotice {
  if (next.kind === 'finished') return next;
  if (next.kind === 'progress' && current.kind !== 'finished') return next;
  if (current.kind === 'result') return next;
  return current;
}

/** Agrupa invalidaciones mientras hay una lectura pendiente, sin temporizadores. */
export function useScanRefresh(
  refresh: (notice: ScanRefreshNotice) => Promise<unknown>,
): void {
  useEffect(() => {
    let active = true;
    let reading = false;
    let dirty = false;
    let queued: ScanRefreshNotice | null = null;
    async function invalidate(notice: ScanRefreshNotice) {
      queued = queued ? prefer(queued, notice) : notice;
      dirty = true;
      if (reading) return;
      reading = true;
      try {
        while (active && dirty) {
          dirty = false;
          const current = queued ?? { kind: 'result' };
          queued = null;
          // El historial decide si el aviso es un alta o una actualización.
          await refresh(current);
        }
      } finally {
        reading = false;
      }
    }
    const stopProgress = window.cybersoc.scan.onProgress((progress) => {
      void invalidate({ kind: 'progress', jobId: progress.jobId });
    });
    const stopFinished = window.cybersoc.scan.onFinished((job) => {
      void invalidate({ kind: 'finished', jobId: job.id });
    });
    const stopResult = window.cybersoc.scan.onResultUpdated(() => {
      void invalidate({ kind: 'result' });
    });
    return () => {
      active = false;
      stopProgress();
      stopFinished();
      stopResult();
    };
  }, [refresh]);
}
