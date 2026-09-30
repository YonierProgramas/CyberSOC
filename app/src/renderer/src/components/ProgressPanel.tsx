import type { ScanJobDTO, ScanProgress } from '../../../shared/ipc';
import { fileNameOf } from '../scan/format';

export function ProgressPanel({
  progress,
  job,
}: {
  progress: ScanProgress | null;
  job: ScanJobDTO | null;
}) {
  const discovering = progress
    ? !progress.discoveryDone
    : job?.status === 'DISCOVERING' || job?.status === 'CREATED';
  const percent = discovering ? null : (progress?.percent ?? null);
  const discovered = progress?.discovered ?? job?.filesDiscovered ?? 0;
  const processed = progress?.processed ?? job?.filesProcessed ?? 0;
  const errors = progress?.errors ?? job?.filesError ?? 0;
  const skipped = progress?.skipped ?? job?.filesSkipped ?? 0;
  const current = progress?.currentPath;

  return (
    <section className="panel" aria-live="polite">
      <h2>Progreso</h2>
      <div
        className={
          percent === null ? 'progress-bar indeterminate' : 'progress-bar'
        }
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
        aria-label={
          percent === null
            ? 'Descubriendo archivos'
            : `Análisis al ${Math.round(percent)} por ciento`
        }
      >
        <span
          style={
            percent === null
              ? undefined
              : { width: `${Math.min(100, Math.max(0, percent))}%` }
          }
        />
      </div>
      <p>
        {percent === null
          ? 'Buscando archivos…'
          : `${Math.round(percent)} % analizado`}
      </p>
      <dl className="counters">
        <div>
          <dt>Descubiertos</dt>
          <dd>{discovered}</dd>
        </div>
        <div>
          <dt>Analizados</dt>
          <dd>{processed}</dd>
        </div>
        <div>
          <dt>Errores</dt>
          <dd>{errors}</dd>
        </div>
        <div>
          <dt>Omitidos</dt>
          <dd>{skipped}</dd>
        </div>
      </dl>
      <p className="current-file">
        Archivo actual:{' '}
        {current ? (
          <span title={current}>{fileNameOf(current)}</span>
        ) : (
          'ninguno'
        )}
      </p>
    </section>
  );
}
