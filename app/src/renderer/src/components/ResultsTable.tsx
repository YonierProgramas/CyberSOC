import { useEffect, useState } from 'react';
import type { Page, ScanResultDTO } from '../../../shared/ipc';
import {
  historyFiltersActive,
  resultMatchesFilters,
  type HistoryFilters,
} from '../history/filters';
import {
  PAGE_SIZE,
  formatBytes,
  resultStatusLabel,
  shortHash,
  verdictLabel,
} from '../scan/format';
import { ResultDetail } from './ResultDetail';

const MAX_FILTER_PAGES = 50;

async function loadFiltered(
  jobId: string,
  filters: HistoryFilters,
): Promise<{ items: ScanResultDTO[]; truncated: boolean }> {
  const collected: ScanResultDTO[] = [];
  let offset = 0;
  let truncated = false;
  for (let page = 0; page < MAX_FILTER_PAGES; page += 1) {
    const result = await window.cybersoc.scan.listResults({
      jobId,
      offset,
      limit: PAGE_SIZE,
    });
    collected.push(
      ...result.items.filter((item) => resultMatchesFilters(item, filters)),
    );
    offset += result.items.length;
    if (result.items.length === 0 || offset >= result.total) {
      return { items: collected, truncated: false };
    }
  }
  truncated = true;
  return { items: collected, truncated };
}

export function ResultsTable({
  jobId,
  profileJson = null,
  refreshToken = 0,
  focusResultId = null,
  onSelectResult,
  filters,
}: {
  jobId: string;
  profileJson?: string | null;
  refreshToken?: number;
  focusResultId?: string | null;
  onSelectResult?: (result: { id: string; fileName: string }) => void;
  filters?: HistoryFilters;
}) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Page<ScanResultDTO> | null>(null);
  const [filtered, setFiltered] = useState<ScanResultDTO[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const filterKey = filters ? JSON.stringify(filters) : '';
  const filtering = filters ? historyFiltersActive(filters) : false;

  useEffect(() => {
    setPage(0);
    setSelectedId(null);
  }, [jobId]);

  useEffect(() => {
    setPage(0);
  }, [filterKey]);

  useEffect(() => {
    if (!focusResultId) return;
    setSelectedId(focusResultId);
    const source = filtered ?? data?.items ?? [];
    const found = source.find((item) => item.id === focusResultId);
    if (found) onSelectResult?.({ id: found.id, fileName: found.fileName });
  }, [focusResultId, data, filtered, onSelectResult]);

  useEffect(() => {
    if (!focusResultId || filtering) return;
    let cancelled = false;
    void (async () => {
      let offset = 0;
      let pageIndex = 0;
      while (!cancelled && pageIndex < MAX_FILTER_PAGES) {
        const result = await window.cybersoc.scan.listResults({
          jobId,
          offset,
          limit: PAGE_SIZE,
        });
        if (result.items.some((item) => item.id === focusResultId)) {
          setPage(pageIndex);
          return;
        }
        offset += result.items.length;
        pageIndex += 1;
        if (result.items.length === 0 || offset >= result.total) return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [focusResultId, jobId, filtering]);

  useEffect(() => {
    if (filtering) return;
    let active = true;
    setFailed(false);
    void window.cybersoc.scan
      .listResults({ jobId, offset: page * PAGE_SIZE, limit: PAGE_SIZE })
      .then((result) => {
        if (!active) return;
        setFiltered(null);
        setTruncated(false);
        setData(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [jobId, page, refreshToken, filtering]);

  useEffect(() => {
    if (!filtering || !filters) return;
    let active = true;
    setFailed(false);
    void loadFiltered(jobId, filters)
      .then((result) => {
        if (!active) return;
        setData(null);
        setFiltered(result.items);
        setTruncated(result.truncated);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [jobId, refreshToken, filtering, filters]);

  async function copyHash(hash: string) {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(hash);
    } catch {
      setCopied(null);
    }
  }

  const total = filtered ? filtered.length : (data?.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const items = filtered
    ? filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
    : (data?.items ?? []);

  return (
    <section data-testid="results-panel" className="panel">
      <h2>Resultados</h2>
      {filtering && (
        <p data-testid="history-match-count">{total} coincidencias</p>
      )}
      {failed && <p role="alert">No se pudieron cargar los resultados.</p>}
      {truncated && (
        <p data-testid="history-filter-limit">
          Los filtros se aplicaron a los primeros {MAX_FILTER_PAGES * PAGE_SIZE}{' '}
          resultados.
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Ruta</th>
              <th>Tamaño</th>
              <th>SHA-256</th>
              <th>Estado</th>
              <th>Veredicto</th>
            </tr>
          </thead>
          <tbody>
            {items.length ? (
              items.map((result) => {
                const hash = result.sha256;
                return (
                  <tr
                    key={result.id}
                    data-testid="result-row"
                    data-result-id={result.id}
                    aria-selected={selectedId === result.id}
                    onClick={() => {
                      setSelectedId(result.id);
                      onSelectResult?.({
                        id: result.id,
                        fileName: result.fileName,
                      });
                    }}
                  >
                    <td>{result.fileName}</td>
                    <td className="path" title={result.path}>
                      {result.path}
                    </td>
                    <td>{formatBytes(result.sizeBytes)}</td>
                    <td>
                      {hash ? (
                        <>
                          <code title={hash}>{shortHash(hash)}</code>
                          <button
                            type="button"
                            onClick={() => void copyHash(hash)}
                          >
                            {copied === hash ? 'Copiado' : 'Copiar'}
                          </button>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {resultStatusLabel(result.status)}
                      {result.errorCode && <code> · {result.errorCode}</code>}
                    </td>
                    <td>{verdictLabel(result.verdict)}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={6}>
                  {filtering
                    ? 'Ningún resultado coincide con los filtros.'
                    : 'Sin resultados en esta página.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pager" data-testid="results-pager">
        <button
          type="button"
          data-testid="results-prev"
          disabled={safePage === 0}
          onClick={() => setPage((current) => Math.max(0, current - 1))}
        >
          Anterior
        </button>
        <span data-testid="results-page">
          Página {safePage + 1} de {pageCount}
        </span>
        <button
          type="button"
          data-testid="results-next"
          disabled={safePage + 1 >= pageCount}
          onClick={() => setPage((current) => current + 1)}
        >
          Siguiente
        </button>
      </div>
      {selectedId && (
        <ResultDetail resultId={selectedId} profileJson={profileJson} />
      )}
    </section>
  );
}
