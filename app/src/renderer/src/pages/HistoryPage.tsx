import { useCallback, useEffect, useState } from 'react';
import type { ScanJobDTO } from '../../../shared/ipc';
import { HistoryFilterForm } from '../components/HistoryFilterForm';
import { JobDetail } from '../components/JobDetail';
import { JobSummaryCard } from '../components/JobSummaryCard';
import { PlainText } from '../components/PlainText';
import { ResultsTable } from '../components/ResultsTable';
import { pathLabel, useCopilotFocus } from '../copilot/focus';
import { emptyHistoryFilters, type HistoryFilters } from '../history/filters';
import { useShell } from '../navigation/shell';
import { jobStatusLabel, zoneLabel } from '../scan/format';

export function HistoryPage() {
  const [jobs, setJobs] = useState<ScanJobDTO[]>([]);
  const [selected, setSelected] = useState<ScanJobDTO | null>(null);
  const [focusResultId, setFocusResultId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [filters, setFilters] = useState<HistoryFilters>(emptyHistoryFilters);
  const [ruleId, setRuleId] = useState<string | null>(null);
  const { setFocus } = useCopilotFocus();
  const { request } = useShell();
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

  const openJob = useCallback(
    async (jobId: string, result?: { id: string; fileName: string }) => {
      setFailed(false);
      try {
        setFocusResultId(result?.id ?? null);
        const job = await window.cybersoc.scan.getJob(jobId);
        setSelected(job);
        if (result) {
          setFocus({
            kind: 'RESULT',
            resultId: result.id,
            label: result.fileName,
          });
        } else {
          setFocus({
            kind: 'JOB',
            jobId: job.id,
            label: pathLabel(job.targetPath),
          });
        }
      } catch {
        setFailed(true);
      }
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

  useEffect(() => {
    if (!request) return;
    if (request.kind === 'ZONE') {
      setFilters((current) => ({ ...current, zone: request.zoneId }));
      return;
    }
    if (request.kind === 'RULE') {
      setRuleId(request.ruleId);
      return;
    }
    if (request.kind === 'JOB') {
      void openJob(request.jobId);
      return;
    }
    let active = true;
    setFilters(emptyHistoryFilters);
    void window.cybersoc.scan
      .getResult(request.resultId)
      .then((detail) => {
        if (!active) return;
        return openJob(detail.result.jobId, {
          id: detail.result.id,
          fileName: detail.result.fileName,
        });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [request, openJob]);

  const zoneText = zoneLabel(filters.zone);

  return (
    <main className="wide">
      <p className="eyebrow">Historial</p>
      <h1>Trabajos recientes</h1>
      {failed && <p role="alert">No se pudo consultar el historial.</p>}
      {ruleId && (
        <section className="panel" data-testid="cited-rule">
          <h2>Regla citada</h2>
          <PlainText text={ruleId} />
        </section>
      )}
      <HistoryFilterForm filters={filters} onChange={setFilters} />
      {filters.zone !== '' && (
        <p data-testid="cited-zone">
          Zona: {zoneText === '—' ? filters.zone : zoneText}
        </p>
      )}
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
            filters={filters}
          />
        </>
      )}
    </main>
  );
}
