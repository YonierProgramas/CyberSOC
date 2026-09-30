import { useEffect, useState } from 'react';
import type { ScanJobDTO } from '../../../shared/ipc';
import { JobDetail } from '../components/JobDetail';
import { ResultsTable } from '../components/ResultsTable';
import { jobStatusLabel } from '../scan/format';

export function HistoryPage() {
  const [jobs, setJobs] = useState<ScanJobDTO[]>([]);
  const [selected, setSelected] = useState<ScanJobDTO | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void window.cybersoc.scan
      .listJobs()
      .then((recent) => {
        if (active) setJobs(recent);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  async function openJob(jobId: string) {
    setFailed(false);
    try {
      setSelected(await window.cybersoc.scan.getJob(jobId));
    } catch {
      setFailed(true);
    }
  }

  return (
    <main className="wide">
      <p className="eyebrow">Historial</p>
      <h1>Trabajos recientes</h1>
      {failed && <p role="alert">No se pudo consultar el historial.</p>}
      {jobs.length === 0 ? (
        <p>Todavía no hay escaneos guardados.</p>
      ) : (
        <ul className="job-list">
          {jobs.map((job) => (
            <li key={job.id}>
              <button type="button" onClick={() => void openJob(job.id)}>
                <span>{job.targetPath}</span>
                <span>{jobStatusLabel(job.status)}</span>
                <span>
                  {job.filesProcessed} analizados · {job.filesError} errores ·{' '}
                  {job.filesSkipped} omitidos
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <>
          <JobDetail job={selected} />
          <ResultsTable jobId={selected.id} />
        </>
      )}
    </main>
  );
}
