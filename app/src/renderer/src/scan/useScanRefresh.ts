import { useEffect } from 'react';

/** The latest notice the history has not read yet. */
export type ScanRefreshNotice =
  | { kind: 'progress'; jobId: string }
  | { kind: 'finished'; jobId: string }
  | { kind: 'result' };

/**
 * An analysis that finishes must not get lost behind an earlier progress update.
 * A result change does not replace the id of the analysis that just arrived.
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

/** Groups invalidations while a read is pending, without timers. */
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
          // The history decides whether the notice is an addition or an update.
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
