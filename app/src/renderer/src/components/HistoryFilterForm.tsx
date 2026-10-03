import type { ScanResultDTO } from '../../../shared/ipc';
import type { HistoryFilters } from '../history/filters';
import { emptyHistoryFilters } from '../history/filters';
import { verdictLabel, ZONE_IDS, zoneLabel } from '../scan/format';

const verdicts: ScanResultDTO['verdict'][] = [
  'DETECTED',
  'SUSPICIOUS',
  'CLEAN',
  'NOT_ANALYZED',
  'NOT_EVALUATED',
];

export function HistoryFilterForm({
  filters,
  onChange,
}: {
  filters: HistoryFilters;
  onChange: (filters: HistoryFilters) => void;
}) {
  function patch(partial: Partial<HistoryFilters>) {
    onChange({ ...filters, ...partial });
  }

  return (
    <form
      className="history-filters"
      data-testid="history-filters"
      onSubmit={(event) => event.preventDefault()}
    >
      <label>
        Veredicto
        <select
          data-testid="history-filter-verdict"
          value={filters.verdict}
          onChange={(event) =>
            patch({
              verdict: event.target.value as HistoryFilters['verdict'],
            })
          }
        >
          <option value="">Todos</option>
          {verdicts.map((verdict) => (
            <option key={verdict} value={verdict}>
              {verdictLabel(verdict)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Desde
        <input
          type="date"
          data-testid="history-filter-from"
          value={filters.from}
          onChange={(event) => patch({ from: event.target.value })}
        />
      </label>
      <label>
        Hasta
        <input
          type="date"
          data-testid="history-filter-to"
          value={filters.to}
          onChange={(event) => patch({ to: event.target.value })}
        />
      </label>
      <label>
        Riesgo mínimo
        <input
          type="number"
          min={0}
          max={100}
          data-testid="history-filter-min-risk"
          value={filters.minRisk}
          onChange={(event) => patch({ minRisk: event.target.value })}
        />
      </label>
      <label>
        Zona
        <select
          data-testid="history-filter-zone"
          value={filters.zone}
          onChange={(event) => patch({ zone: event.target.value })}
        >
          <option value="">Todas</option>
          {ZONE_IDS.map((zone) => (
            <option key={zone} value={zone}>
              {zoneLabel(zone)}
            </option>
          ))}
          {filters.zone !== '' &&
            !(ZONE_IDS as readonly string[]).includes(filters.zone) && (
              <option value={filters.zone}>{filters.zone}</option>
            )}
        </select>
      </label>
      <label>
        Texto de ruta
        <input
          type="search"
          data-testid="history-filter-path"
          value={filters.pathText}
          onChange={(event) => patch({ pathText: event.target.value })}
        />
      </label>
      <button
        type="button"
        data-testid="history-filter-clear"
        onClick={() => onChange(emptyHistoryFilters)}
      >
        Limpiar filtros
      </button>
    </form>
  );
}
