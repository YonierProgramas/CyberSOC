import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DashboardOverviewDTO,
  DashboardScope,
  ScanJobDTO,
  VerdictDistributionDTO,
} from '../../../shared/ipc';
import { CountChart } from '../components/CountChart';
import { StatusBadge, StatCard, jobTone } from '../components/ui';
import {
  SCOPE_LABEL,
  activityTitle,
  scopeNotice,
  verdictRows,
} from '../dashboard/present';
import { useShell } from '../navigation/shell';
import { fileNameOf, jobStatusLabel, zoneLabel } from '../scan/format';
import { useScanRefresh } from '../scan/useScanRefresh';
import { engineHeadline, useEngineStatus } from '../system/engineStatus';

const scopes: DashboardScope[] = ['LAST_COMPLETED', 'ALL_COMPLETED', 'RANGE'];

export function DashboardPage() {
  const { setView, requestScan, openReference } = useShell();
  const engine = useEngineStatus();
  const [overview, setOverview] = useState<DashboardOverviewDTO | null>(null);
  const [recent, setRecent] = useState<ScanJobDTO[]>([]);
  const [recentFailed, setRecentFailed] = useState(false);
  const [scope, setScope] = useState<DashboardScope>('LAST_COMPLETED');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const applied = useRef<{ from: string; to: string } | undefined>(undefined);

  const load = useCallback((range?: { from: string; to: string }) => {
    const token = ++request.current;
    applied.current = range;
    setLoading(true);
    setFailed(false);
    const query =
      range === undefined ? undefined : { from: range.from, to: range.to };
    return window.cybersoc.dashboard
      .getOverview(query)
      .then((next) => {
        if (token !== request.current) return;
        setOverview(next);
        setLoading(false);
      })
      .catch(() => {
        if (token !== request.current) return;
        setFailed(true);
        setLoading(false);
      });
  }, []);

  const loadRecent = useCallback(() => {
    return window.cybersoc.scan
      .listJobsPage({ offset: 0, limit: 5 })
      .then((page) => {
        setRecent(page.items);
        setRecentFailed(false);
      })
      .catch(() => setRecentFailed(true));
  }, []);

  useEffect(() => {
    void load();
    void loadRecent();
    return () => {
      request.current += 1;
    };
  }, [load, loadRecent]);

  const refresh = useCallback(() => {
    void loadRecent();
    return load(applied.current);
  }, [load, loadRecent]);
  useScanRefresh(refresh);

  function applyRange() {
    if (from === '' || to === '' || from > to) return;
    setScope('RANGE');
    void load({ from, to });
  }

  const distribution = overview ? selectedDistribution(overview, scope) : null;
  const completed = overview?.distributions.allCompleted;
  const lastJob = overview?.distributions.lastCompleted?.job;
  const lastStamp =
    lastJob?.finishedAt ??
    lastJob?.createdAt ??
    overview?.active?.createdAt ??
    overview?.allTime.firstJobAt;

  return (
    <main className="wide">
      <header className="page-header">
        <div className="page-header-copy">
          <p className="eyebrow">Inicio</p>
          <h1>Resumen</h1>
          <p className="lede">
            Cifras tomadas de los análisis guardados en este equipo.{' '}
            {engineHeadline(engine)}.
          </p>
          <p className="hint">
            Última actividad registrada:{' '}
            {overview ? formatStamp(lastStamp) : 'Sin datos'}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="primary"
            onClick={() => requestScan('FOLDER')}
          >
            Iniciar escaneo
          </button>
        </div>
      </header>
      <section className="panel" aria-label="Acciones rápidas">
        <h2>Acciones rápidas</h2>
        <div className="actions">
          <button type="button" onClick={() => requestScan('FILE')}>
            Escanear archivo
          </button>
          <button type="button" onClick={() => requestScan('FOLDER')}>
            Escanear carpeta
          </button>
          <button type="button" onClick={() => setView('history')}>
            Ver historial
          </button>
          <button type="button" onClick={() => setView('quarantine')}>
            Consultar cuarentena
          </button>
        </div>
      </section>
      {loading && <p data-testid="dashboard-loading">Cargando el resumen…</p>}
      {failed && (
        <p role="alert">
          No se pudo cargar el resumen.{' '}
          <button
            type="button"
            data-testid="dashboard-retry"
            onClick={() => load(applied.current)}
          >
            Reintentar
          </button>
        </p>
      )}
      {overview && completed && (
        <>
          <section className="kpi-grid" aria-label="Indicadores del equipo">
            <StatCard
              label="Análisis registrados"
              value={String(overview.allTime.jobs)}
              hint="Trabajos guardados en total"
            />
            <StatCard
              label="Resultados registrados"
              value={String(overview.allTime.results)}
              hint="Filas de resultado, no un recuento inventado de archivos"
            />
            <StatCard
              label="Detectados"
              value={String(completed.results.byVerdict.DETECTED)}
              hint="Solo análisis completados"
              tone={
                completed.results.byVerdict.DETECTED > 0 ? 'bad' : 'neutral'
              }
            />
            <StatCard
              label="Sospechosos"
              value={String(completed.results.byVerdict.SUSPICIOUS)}
              hint="Solo análisis completados"
              tone={
                completed.results.byVerdict.SUSPICIOUS > 0 ? 'warn' : 'neutral'
              }
            />
            <StatCard
              label="En cuarentena"
              value={String(overview.quarantine.QUARANTINED ?? 0)}
              hint="Elementos con estado QUARANTINED"
            />
            <StatCard
              label="Último análisis"
              value={
                lastJob
                  ? formatStamp(lastJob.finishedAt ?? lastJob.createdAt)
                  : 'Sin datos'
              }
              hint={
                lastJob
                  ? fileNameOf(lastJob.targetPath)
                  : 'Todavía no hay un análisis completado'
              }
            />
          </section>
          <section className="panel" data-testid="dashboard-active">
            <h2>Análisis en curso</h2>
            {overview.active ? (
              <p>
                {fileNameOf(overview.active.targetPath)} ·{' '}
                <StatusBadge tone={jobTone(overview.active.status)}>
                  {jobStatusLabel(overview.active.status)}
                </StatusBadge>
              </p>
            ) : (
              <p>No hay un análisis en curso.</p>
            )}
            <p className="hint">
              Sale del registro local más reciente con estado sin terminar. No
              afirma que el proceso del motor siga vivo.
            </p>
          </section>
          <section className="panel" data-testid="dashboard-last">
            <h2>Último análisis completado</h2>
            {overview.distributions.lastCompleted ? (
              <p>
                {fileNameOf(
                  overview.distributions.lastCompleted.job.targetPath,
                )}{' '}
                · {overview.distributions.lastCompleted.results.total}{' '}
                resultados
              </p>
            ) : (
              <p>Todavía no hay un análisis completado.</p>
            )}
            <button type="button" onClick={() => setView('history')}>
              Ver historial
            </button>
          </section>
          <section className="panel" data-testid="dashboard-activity">
            <h2>{activityTitle(overview)}</h2>
            <p>
              Del {overview.range.from} al {overview.range.to}. En total hay{' '}
              {overview.allTime.jobs} análisis y {overview.allTime.results}{' '}
              resultados.
            </p>
            <CountChart
              title="Trabajos por día"
              testId="dashboard-activity-chart"
              rows={overview.activity.daily.map((day) => ({
                key: day.date,
                label: day.date,
                count: day.jobs,
              }))}
            />
            <details>
              <summary>
                Ver resultados, detecciones y errores de cada día
              </summary>
              <div className="table-wrap">
                <table>
                  <caption>Detalle diario entregado por el resumen</caption>
                  <thead>
                    <tr>
                      <th scope="col">Día</th>
                      <th scope="col">Trabajos</th>
                      <th scope="col">Resultados</th>
                      <th scope="col">Detectados</th>
                      <th scope="col">Sospechosos</th>
                      <th scope="col">Errores</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.activity.daily.map((day) => (
                      <tr key={day.date}>
                        <th scope="row">{day.date}</th>
                        <td>{day.jobs}</td>
                        <td>{day.results}</td>
                        <td>{day.detected}</td>
                        <td>{day.suspicious}</td>
                        <td>{day.errors}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>
          <section className="panel" data-testid="dashboard-distribution">
            <h2>Distribución de resultados</h2>
            <div
              className="scope-choices"
              role="group"
              aria-label="Ámbito de la distribución"
            >
              {scopes.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={scope === item}
                  data-testid={`dashboard-scope-${item}`}
                  onClick={() => setScope(item)}
                >
                  {SCOPE_LABEL[item]}
                </button>
              ))}
            </div>
            <form
              className="history-filters"
              onSubmit={(event) => {
                event.preventDefault();
                applyRange();
              }}
            >
              <label>
                Desde
                <input
                  type="date"
                  value={from}
                  data-testid="dashboard-from"
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label>
                Hasta
                <input
                  type="date"
                  value={to}
                  data-testid="dashboard-to"
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>
              <button type="submit" data-testid="dashboard-apply-range">
                Aplicar rango
              </button>
            </form>
            {distribution && (
              <>
                <p data-testid="dashboard-scope-notice">
                  {scopeNotice(distribution)} Ámbito: {SCOPE_LABEL[scope]}.
                  Trabajos incluidos: {distribution.jobs}. Trabajos fuera:{' '}
                  {distribution.excluded.jobs}.
                </p>
                <CountChart
                  variant="donut"
                  title={`Veredictos de ${SCOPE_LABEL[scope]}`}
                  testId="dashboard-verdict-chart"
                  rows={verdictRows(distribution)}
                />
                <ZoneChart distribution={distribution} />
              </>
            )}
            <details>
              <summary>Cómo leer estas cifras</summary>
              <p>
                Último es solo el análisis completado más reciente. Todos reúne
                los completados. Rango usa las fechas elegidas e incluye también
                los que no terminaron. Un error, un archivo no analizado o un
                trabajo cancelado no cuenta como sin hallazgos. El gráfico y la
                tabla muestran las mismas cantidades.
              </p>
            </details>
          </section>
          <section className="panel" data-testid="dashboard-recent">
            <h2>Actividad reciente</h2>
            <p className="hint">
              Los cinco análisis más recientes del listado local.
            </p>
            {recentFailed && (
              <p role="alert">No se pudo cargar la actividad reciente.</p>
            )}
            {!recentFailed && recent.length === 0 && (
              <p>Sin análisis recientes.</p>
            )}
            {recent.length > 0 && (
              <ul className="job-list">
                {recent.map((job) => (
                  <li key={job.id}>
                    <button
                      type="button"
                      onClick={() => openReference({ type: 'job', id: job.id })}
                    >
                      <span>{formatStamp(job.createdAt)}</span>
                      {' · '}
                      <span title={job.targetPath}>{job.targetPath}</span>
                      {' · '}
                      <StatusBadge tone={jobTone(job.status)}>
                        {jobStatusLabel(job.status)}
                      </StatusBadge>
                      {' · '}
                      <span>{job.filesProcessed} analizados</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function ZoneChart({ distribution }: { distribution: VerdictDistributionDTO }) {
  const rows = distribution.results.byZone
    .filter((item) => item.results > 0)
    .map((item) => ({
      key: item.zone ?? 'SIN_ZONA',
      label: zoneLabel(item.zone),
      count: item.results,
    }));
  if (rows.length === 0) {
    return <p className="hint">Sin resultados por zona en este ámbito.</p>;
  }
  return (
    <CountChart
      title="Resultados por zona"
      testId="dashboard-zone-chart"
      rows={rows}
    />
  );
}

function selectedDistribution(
  overview: DashboardOverviewDTO,
  scope: DashboardScope,
): VerdictDistributionDTO | null {
  if (scope === 'LAST_COMPLETED') return overview.distributions.lastCompleted;
  if (scope === 'ALL_COMPLETED') return overview.distributions.allCompleted;
  return overview.distributions.range;
}

function formatStamp(value: string | null | undefined): string {
  if (!value) return 'Sin datos';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
