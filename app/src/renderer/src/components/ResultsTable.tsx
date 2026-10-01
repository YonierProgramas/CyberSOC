import { useEffect, useState } from 'react';
import type { Page, ScanResultDTO } from '../../../shared/ipc';
import {
  PAGE_SIZE,
  formatBytes,
  resultStatusLabel,
  shortHash,
  verdictLabel,
} from '../scan/format';
import { ResultDetail } from './ResultDetail';

export function ResultsTable({
  jobId,
  refreshToken = 0,
}: {
  jobId: string;
  refreshToken?: number;
}) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Page<ScanResultDTO> | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setPage(0);
    setSelectedId(null);
  }, [jobId]);

  useEffect(() => {
    let active = true;
    setFailed(false);
    void window.cybersoc.scan
      .listResults({ jobId, offset: page * PAGE_SIZE, limit: PAGE_SIZE })
      .then((result) => {
        if (active) setData(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [jobId, page, refreshToken]);

  async function copyHash(hash: string) {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(hash);
    } catch {
      setCopied(null);
    }
  }

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section data-testid="results-panel" className="panel">
      <h2>Resultados</h2>
      {failed && <p role="alert">No se pudieron cargar los resultados.</p>}
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
            {data?.items.length ? (
              data.items.map((result) => {
                const hash = result.sha256;
                return (
                  <tr
                    key={result.id}
                    data-testid="result-row"
                    data-result-id={result.id}
                    aria-selected={selectedId === result.id}
                    onClick={() => setSelectedId(result.id)}
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
                <td colSpan={6}>Sin resultados en esta página.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => setPage((current) => current - 1)}
        >
          Anterior
        </button>
        <span>
          Página {Math.min(page + 1, pageCount)} de {pageCount}
        </span>
        <button
          type="button"
          disabled={page + 1 >= pageCount}
          onClick={() => setPage((current) => current + 1)}
        >
          Siguiente
        </button>
      </div>
      {selectedId && <ResultDetail resultId={selectedId} />}
    </section>
  );
}
