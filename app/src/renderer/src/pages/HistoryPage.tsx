import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanJobDTO, ScanJobStatus } from '../../../shared/ipc';
import { HistoryFilterForm } from '../components/HistoryFilterForm';
import { JobDetail } from '../components/JobDetail';
import { JobSummaryCard } from '../components/JobSummaryCard';
import { PlainText } from '../components/PlainText';
import { ResultsTable } from '../components/ResultsTable';
import { pathLabel, useCopilotFocus } from '../copilot/focus';
import { historyPageNotice } from '../dashboard/present';
import { emptyHistoryFilters, type HistoryFilters } from '../history/filters';
import { useShell } from '../navigation/shell';
import { offsetAfterArrival, shouldProbeArrival } from '../paging/arrival';
import { jobStatusLabel, zoneLabel } from '../scan/format';
import { useScanRefresh, type ScanRefreshNotice } from '../scan/useScanRefresh';

const JOB_PAGE_SIZE = 20;

interface JobQuery {
  status: '' | ScanJobStatus;
  from: string;
  to: string;
}

const emptyJobQuery: JobQuery = { status: '', from: '', to: '' };

export function HistoryPage() {
  const [jobs, setJobs] = useState<ScanJobDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [jobQuery, setJobQuery] = useState<JobQuery>(emptyJobQuery);
  const [jobDraft, setJobDraft] = useState<JobQuery>(emptyJobQuery);
  const [selected, setSelected] = useState<ScanJobDTO | null>(null);
  const [focusResultId, setFocusResultId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);
  const [filters, setFilters] = useState<HistoryFilters>(emptyHistoryFilters);
  const [ruleId, setRuleId] = useState<string | null>(null);
  const pageToken = useRef(0);
  const detailToken = useRef(0);
  const selectedJobId = useRef<string | null>(null);
  const offsetRef = useRef(0);
  const queryRef = useRef(jobQuery);
  // Conjunto: cada id entra una sola vez por filtro. Un alta es un id ausente;
  // una actualización es un id ya listado. has/add son O(1) en promedio.
  const seenIds = useRef(new Set<string>());
  const matchedIds = useRef(new Set<string>());
  const appliedQuery = useRef(jobQuery);
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
    async (
      target:
        { kind: 'JOB'; jobId: string } | { kind: 'RESULT'; resultId: string },
    ) => {
      const token = ++detailToken.current;
      selectedJobId.current = null;
      setSelected(null);
      setFocusResultId(null);
      setDetailLoading(true);
      setDetailFailed(false);
      try {
        const result =
          target.kind === 'RESULT'
            ? (await window.cybersoc.scan.getResult(target.resultId)).result
            : null;
        if (token !== detailToken.current) return;
        const jobId = target.kind === 'JOB' ? target.jobId : result!.jobId;
        const job = await window.cybersoc.scan.getJob(jobId);
        if (token !== detailToken.current) return;
        selectedJobId.current = job.id;
        setSelected(job);
        setFocusResultId(result?.id ?? null);
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
        if (token === detailToken.current) setDetailFailed(true);
      } finally {
        if (token === detailToken.current) setDetailLoading(false);
      }
    },
    [setFocus],
  );

  const loadJobs = useCallback(
    (nextOffset: number, query: JobQuery, background = false) => {
      const token = ++pageToken.current;
      // La revalidación conserva la página y sus metadatos visibles. Solo una
      // navegación/filtro nuevo reemplaza la página por la carga inicial.
      if (!background) setLoading(true);
      setFailed(false);
      if (!background) setJobs([]);
      return window.cybersoc.scan
        .listJobsPage({
          offset: nextOffset,
          limit: JOB_PAGE_SIZE,
          ...(query.status === '' ? {} : { statuses: [query.status] }),
          ...(query.from === '' ? {} : { from: query.from }),
          ...(query.to === '' ? {} : { to: query.to }),
        })
        .then((page) => {
          if (token !== pageToken.current) return;
          for (const job of page.items) {
            seenIds.current.add(job.id);
            matchedIds.current.add(job.id);
          }
          setJobs(page.items);
          setTotal(page.total);
          setLoading(false);
        })
        .catch(() => {
          if (token !== pageToken.current) return;
          setFailed(true);
          setLoading(false);
        });
    },
    [],
  );

  useEffect(() => {
    if (appliedQuery.current !== jobQuery) {
      appliedQuery.current = jobQuery;
      seenIds.current.clear();
      matchedIds.current.clear();
    }
    void loadJobs(offset, jobQuery);
    return () => {
      pageToken.current += 1;
    };
  }, [loadJobs, offset, jobQuery]);

  const showPage = useCallback((nextOffset: number) => {
    offsetRef.current = nextOffset;
    setOffset(nextOffset);
  }, []);

  const reloadSelection = useCallback(async () => {
    const id = selectedJobId.current;
    const token = detailToken.current;
    if (!id) return;
    try {
      const job = await window.cybersoc.scan.getJob(id);
      if (token === detailToken.current && id === selectedJobId.current) {
        setSelected(job);
        setDetailVersion((value) => value + 1);
      }
    } catch {
      if (token === detailToken.current) setDetailFailed(true);
    }
  }, []);

  const refresh = useCallback(
    async (notice: ScanRefreshNotice) => {
      if (notice.kind === 'result') {
        await loadJobs(offsetRef.current, queryRef.current, true);
        await reloadSelection();
        return;
      }
      const id = notice.jobId;
      const probe = shouldProbeArrival({
        matched: matchedIds.current.has(id),
        seen: seenIds.current.has(id),
        finished: notice.kind === 'finished',
      });
      if (!probe) {
        await loadJobs(offsetRef.current, queryRef.current, true);
        await reloadSelection();
        return;
      }
      const token = ++pageToken.current;
      const query = queryRef.current;
      try {
        const head = await window.cybersoc.scan.listJobsPage({
          offset: 0,
          limit: JOB_PAGE_SIZE,
          ...(query.status === '' ? {} : { statuses: [query.status] }),
          ...(query.from === '' ? {} : { from: query.from }),
          ...(query.to === '' ? {} : { to: query.to }),
        });
        if (token !== pageToken.current) return;
        const appears = head.items.some((job) => job.id === id);
        const nextOffset = offsetAfterArrival(offsetRef.current, appears);
        if (appears) {
          for (const job of head.items) {
            seenIds.current.add(job.id);
            matchedIds.current.add(job.id);
          }
          if (nextOffset !== offsetRef.current) {
            showPage(0);
          } else {
            setJobs(head.items);
            setTotal(head.total);
            setLoading(false);
            setFailed(false);
          }
        } else {
          seenIds.current.add(id);
          await loadJobs(offsetRef.current, query, true);
        }
      } catch {
        if (token === pageToken.current) {
          setFailed(true);
          setLoading(false);
        }
      }
      await reloadSelection();
    },
    [loadJobs, reloadSelection, showPage],
  );
  useScanRefresh(refresh);

  useEffect(
    () => () => {
      detailToken.current += 1;
      selectedJobId.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!request) return;
    if (request.kind === 'ZONE') {
      detailToken.current += 1;
      setDetailLoading(false);
      setFilters((current) => ({ ...current, zone: request.zoneId }));
      return;
    }
    if (request.kind === 'RULE') {
      detailToken.current += 1;
      setDetailLoading(false);
      setRuleId(request.ruleId);
      return;
    }
    if (request.kind === 'JOB') {
      void openJob(request);
      return;
    }
    setFilters(emptyHistoryFilters);
    void openJob(request);
  }, [request, openJob]);

  const zoneText = zoneLabel(filters.zone);

  return (
    <main className="wide">
      <p className="eyebrow">Historial</p>
      <h1>Análisis guardados</h1>
      {!loading && (
        <p data-testid="history-page-notice">
          {historyPageNotice(offset, jobs.length, total)}
        </p>
      )}
      {loading && <p>Cargando el historial…</p>}
      {failed && (
        <p role="alert">
          No se pudo consultar el historial.{' '}
          <button type="button" onClick={() => loadJobs(offset, jobQuery)}>
            Reintentar
          </button>
        </p>
      )}
      {ruleId && (
        <section className="panel" data-testid="cited-rule">
          <h2>Regla citada</h2>
          <PlainText text={ruleId} />
        </section>
      )}
      <form
        className="history-filters"
        onSubmit={(event) => {
          event.preventDefault();
          queryRef.current = jobDraft;
          showPage(0);
          setJobQuery(jobDraft);
        }}
      >
        <label>
          Estado del análisis
          <select
            value={jobDraft.status}
            data-testid="history-job-status"
            onChange={(event) =>
              setJobDraft((current) => ({
                ...current,
                status: event.target.value as JobQuery['status'],
              }))
            }
          >
            <option value="">Todos los estados</option>
            <option value="CREATED">Creado</option>
            <option value="DISCOVERING">Descubriendo</option>
            <option value="SCANNING">Analizando</option>
            <option value="CANCELLING">Cancelando</option>
            <option value="CANCELLED">Cancelado</option>
            <option value="COMPLETED">Completado</option>
            <option value="FAILED">Fallido</option>
          </select>
        </label>
        <label>
          Desde
          <input
            type="date"
            value={jobDraft.from}
            onChange={(event) =>
              setJobDraft((current) => ({
                ...current,
                from: event.target.value,
              }))
            }
          />
        </label>
        <label>
          Hasta
          <input
            type="date"
            value={jobDraft.to}
            onChange={(event) =>
              setJobDraft((current) => ({ ...current, to: event.target.value }))
            }
          />
        </label>
        <button type="submit" data-testid="history-apply-jobs">
          Filtrar análisis
        </button>
      </form>
      <HistoryFilterForm filters={filters} onChange={setFilters} />
      {filters.zone !== '' && (
        <p data-testid="cited-zone">
          Zona: {zoneText === '—' ? filters.zone : zoneText}
        </p>
      )}
      <div className="pager">
        <button
          type="button"
          data-testid="history-prev"
          disabled={offset === 0}
          onClick={() => showPage(Math.max(0, offset - JOB_PAGE_SIZE))}
        >
          Anterior
        </button>
        <button
          type="button"
          data-testid="history-next"
          disabled={offset + jobs.length >= total}
          onClick={() => showPage(offset + JOB_PAGE_SIZE)}
        >
          Siguiente
        </button>
      </div>
      {!loading && jobs.length === 0 ? (
        <p>Todavía no hay escaneos guardados.</p>
      ) : jobs.length === 0 ? null : (
        <ul data-testid="history-list" className="job-list">
          {jobs.map((job) => (
            <li key={job.id}>
              <button
                data-testid="history-job"
                type="button"
                onClick={() => void openJob({ kind: 'JOB', jobId: job.id })}
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
      {detailLoading && <p role="status">Cargando el detalle…</p>}
      {detailFailed && (
        <p role="alert">
          No se pudo cargar el detalle. Selecciona el análisis para reintentar.
        </p>
      )}
      {selected && (
        <>
          <JobDetail job={selected} />
          <JobSummaryCard
            jobId={selected.id}
            refreshToken={detailVersion}
            onOpenResult={setFocusResultId}
          />
          <ResultsTable
            jobId={selected.id}
            profileJson={selected.profileJson}
            refreshToken={detailVersion}
            focusResultId={focusResultId}
            onSelectResult={chooseResult}
            filters={filters}
          />
        </>
      )}
    </main>
  );
}
