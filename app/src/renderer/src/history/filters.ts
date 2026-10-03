import type { ScanResultDTO } from '../../../shared/ipc';

export interface HistoryFilters {
  verdict: '' | ScanResultDTO['verdict'];
  from: string;
  to: string;
  minRisk: string;
  zone: string;
  pathText: string;
}

export const emptyHistoryFilters: HistoryFilters = {
  verdict: '',
  from: '',
  to: '',
  minRisk: '',
  zone: '',
  pathText: '',
};

export function historyFiltersActive(filters: HistoryFilters): boolean {
  return (
    filters.verdict !== '' ||
    filters.from !== '' ||
    filters.to !== '' ||
    filters.minRisk.trim() !== '' ||
    filters.zone !== '' ||
    filters.pathText.trim() !== ''
  );
}

/** El IPC de resultados solo pagina por trabajo. El filtro ocurre en la UI. */
export function resultMatchesFilters(
  result: ScanResultDTO,
  filters: HistoryFilters,
): boolean {
  if (filters.verdict !== '' && result.verdict !== filters.verdict) {
    return false;
  }
  const day = result.scannedAt.slice(0, 10);
  if (filters.from !== '' && day < filters.from) return false;
  if (filters.to !== '' && day > filters.to) return false;
  const minText = filters.minRisk.trim();
  if (minText !== '') {
    const min = Number(minText);
    if (Number.isFinite(min) && (result.engineScore ?? -1) < min) {
      return false;
    }
  }
  if (filters.zone !== '' && result.zone !== filters.zone) return false;
  const needle = filters.pathText.trim().toLowerCase();
  if (needle !== '') {
    const hay = `${result.path}\n${result.fileName}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}
