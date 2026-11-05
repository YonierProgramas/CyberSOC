import type {
  DashboardOverviewDTO,
  DashboardScope,
  ScanResultDTO,
  VerdictDistributionDTO,
} from '../../../shared/ipc';
import { verdictLabel } from '../scan/format';

export const VERDICT_ORDER = [
  'CLEAN',
  'SUSPICIOUS',
  'DETECTED',
  'NOT_ANALYZED',
  'NOT_EVALUATED',
] as const satisfies readonly ScanResultDTO['verdict'][];

// Invariante del diccionario: una etiqueta por ámbito aceptado. Consultar
// una clave cuesta O(1); el conjunto de tres claves no crece con el historial.
export const SCOPE_LABEL: Record<DashboardScope, string> = {
  LAST_COMPLETED: 'Último',
  ALL_COMPLETED: 'Todos',
  RANGE: 'Rango',
};

export interface CountRow {
  key: string;
  label: string;
  count: number;
}

/** Muestra las cifras del Core. No recalcula veredictos ni rellena huecos. */
export function verdictRows(distribution: VerdictDistributionDTO): CountRow[] {
  return VERDICT_ORDER.map((verdict) => ({
    key: verdict,
    label: verdictLabel(verdict),
    count: distribution.results.byVerdict[verdict],
  }));
}

export function activityTitle(overview: DashboardOverviewDTO): string {
  return overview.range.days === 7
    ? 'Actividad de siete días'
    : `Actividad de ${overview.range.days} días`;
}

export function scopeNotice(distribution: VerdictDistributionDTO): string {
  const total = distribution.results.total;
  const excluded = distribution.excluded.results;
  const partial = distribution.partial
    ? ' Hay un análisis en curso: estas cifras están incompletas.'
    : '';
  const excludedNotice =
    distribution.scope === 'LAST_COMPLETED'
      ? `Excluidos de fallidos/cancelados posteriores al último completado: ${excluded} resultados.`
      : distribution.scope === 'ALL_COMPLETED'
        ? `Excluidos de análisis no completados: ${excluded} resultados.`
        : `Excluidos por estado dentro del rango: ${excluded} resultados; se incluyen todos los estados.`;
  if (total === 0) {
    return `No hay resultados en este ámbito. ${excludedNotice}${partial}`;
  }
  return `${total} resultados en este ámbito. ${excludedNotice}${partial}`;
}

export function historyPageNotice(
  offset: number,
  count: number,
  total: number,
): string {
  if (total === 0) return 'No hay análisis guardados.';
  const from = offset + 1;
  const to = offset + count;
  const span = `Análisis ${from}–${to} de ${total}.`;
  if (offset > 0 || to < total) {
    return `${span} Esta página no es todo el historial.`;
  }
  return span;
}

export function barHeight(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.round((value / max) * 100);
}
