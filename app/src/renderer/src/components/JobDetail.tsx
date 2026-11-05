import type { ScanJobDTO } from '../../../shared/ipc';
import {
  formatDuration,
  jobDuration,
  jobStatusLabel,
  readMetrics,
  skippedNotice,
} from '../scan/format';

export function JobDetail({
  job,
  elapsedMs = null,
}: {
  job: ScanJobDTO;
  elapsedMs?: number | null;
}) {
  const metrics = readMetrics(job.metricsJson);
  const duration = jobDuration(job, elapsedMs);
  const skipped = skippedNotice(metrics);
  return (
    <section data-testid="job-detail" className="panel">
      <h2>Detalle del trabajo</h2>
      <p>
        {job.targetKind === 'FILE' ? 'Archivo' : 'Carpeta'}: {job.targetPath}
      </p>
      <p data-testid="job-status">Estado: {jobStatusLabel(job.status)}</p>
      {job.errorMessage && <p role="alert">{job.errorMessage}</p>}
      {skipped && <p data-testid="job-skipped">{skipped}</p>}
      <dl data-testid="structure-metrics" className="counters">
        <div>
          <dt>Pico de la pila</dt>
          <dd>{metrics.peakStackSize ?? '—'}</dd>
        </div>
        <div>
          <dt>Pico de la cola</dt>
          <dd>{metrics.peakQueueSize ?? '—'}</dd>
        </div>
        <div>
          <dt>Tiempo bloqueado del productor</dt>
          <dd>{formatDuration(metrics.producerBlockedMs)}</dd>
        </div>
        <div>
          <dt>Duración</dt>
          <dd>{formatDuration(duration)}</dd>
        </div>
      </dl>
    </section>
  );
}
