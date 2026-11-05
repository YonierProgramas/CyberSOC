import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DashboardOverviewDTO,
  DashboardScope,
  VerdictDistributionDTO,
} from '../../../shared/ipc';
import { CountChart } from '../components/CountChart';
import {
  SCOPE_LABEL,
  activityTitle,
  scopeNotice,
  verdictRows,
} from '../dashboard/present';
import { useShell } from '../navigation/shell';
import { fileNameOf, jobStatusLabel } from '../scan/format';
import { useScanRefresh } from '../scan/useScanRefresh';

const scopes: DashboardScope[] = ['LAST_COMPLETED', 'ALL_COMPLETED', 'RANGE'];

export function DashboardPage() {
  const { setView } = useShell();
  const [overview, setOverview] = useState<DashboardOverviewDTO | null>(null);
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

  useEffect(() => {
    void load();
    return () => {
      request.current += 1;
    };
  }, [load]);

  const refresh = useCallback(() => load(applied.current), [load]);
  useScanRefresh(refresh);

  function applyRange() {
    if (from === '' || to === '' || from > to) return;
    setScope('RANGE');
    load({ from, to });
  }

  const distribution = overview ? selectedDistribution(overview, scope) : null;

  return (
    <main className="wide">
      <p className="eyebrow">Inicio</p>
      <h1>Resumen</h1>
      <p>Las cifras salen de los análisis guardados en este equipo.</p>
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
      {overview && (
        <>
          <section className="panel" data-testid="dashboard-active">
            <h2>Análisis en curso</h2>
            {overview.active ? (
              <p>
                {fileNameOf(overview.active.targetPath)} ·{' '}
                {jobStatusLabel(overview.active.status)}
              </p>
            ) : (
              <p>No hay un análisis en curso.</p>
            )}
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
            </details>
          </section>
          <section className="panel" data-testid="dashboard-distribution">
            <h2>Distribución</h2>
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
                  title={`Veredictos de ${SCOPE_LABEL[scope]}`}
                  testId="dashboard-verdict-chart"
                  rows={verdictRows(distribution)}
                />
              </>
            )}
            <details>
              <summary>Cómo leer estas cifras</summary>
              <p>
                Último es solo el análisis completado más reciente. Todos reúne
                los completados. Rango usa las fechas elegidas e incluye también
                los que no terminaron. Un error, un archivo no analizado o un
                trabajo cancelado no cuenta como limpio. El gráfico y la tabla
                muestran las mismas cantidades.
              </p>
            </details>
          </section>
        </>
      )}
    </main>
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
