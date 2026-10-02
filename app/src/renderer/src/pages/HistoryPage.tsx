import { useCallback, useEffect, useState } from 'react';
import type { ScanJobDTO } from '../../../shared/ipc';
import { JobDetail } from '../components/JobDetail';
import { JobSummaryCard } from '../components/JobSummaryCard';
import { ResultsTable } from '../components/ResultsTable';
import { pathLabel, useCopilotFocus } from '../copilot/focus';
import { jobStatusLabel } from '../scan/format';

export function HistoryPage() {
  const [jobs, setJobs] = useState<ScanJobDTO[]>([]);
  const [selected, setSelected] = useState<ScanJobDTO | null>(null);
  const [focusResultId, setFocusResultId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { setFocus } = useCopilotFocus();
  const chooseResult = useCallback(
    (result: { id: string; fileName: string }) => {
      setFocus({
        kind: 'RESULT',
        resultId: result.id,
        label: result.fileName,
      });
    },
    [setFocus],
  );

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
      setFocusResultId(null);
      const job = await window.cybersoc.scan.getJob(jobId);
      setSelected(job);
      setFocus({
        kind: 'JOB',
        jobId: job.id,
        label: pathLabel(job.targetPath),
      });
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
        <ul data-testid="history-list" className="job-list">
          {jobs.map((job) => (
            <li key={job.id}>
              <button
                data-testid="history-job"
                type="button"
                onClick={() => void openJob(job.id)}
              >
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
          <JobSummaryCard jobId={selected.id} onOpenResult={setFocusResultId} />
          <ResultsTable
            jobId={selected.id}
            profileJson={selected.profileJson}
            focusResultId={focusResultId}
            onSelectResult={chooseResult}
          />
        </>
      )}
    </main>
  );
}
