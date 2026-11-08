import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanJobDTO, ScanProgress, ScanTarget } from '../../../shared/ipc';
import { FileIcon, FolderIcon } from '../components/icons';
import { JobDetail } from '../components/JobDetail';
import { JobSummaryCard } from '../components/JobSummaryCard';
import {
  allLayers,
  customProfile,
  ProfileSelector,
  toggleLayer,
  type ProfileMode,
} from '../components/ProfileSelector';
import { ProgressPanel } from '../components/ProgressPanel';
import { ResultsTable } from '../components/ResultsTable';
import { PageHeader, StatusBadge, jobTone } from '../components/ui';
import { pathLabel, useCopilotFocus } from '../copilot/focus';
import { useShell } from '../navigation/shell';
import { jobStatusLabel } from '../scan/format';
import { engineHeadline, useEngineStatus } from '../system/engineStatus';

const activeStatuses = new Set<ScanJobDTO['status']>([
  'CREATED',
  'DISCOVERING',
  'SCANNING',
  'CANCELLING',
]);

export function ScanPage() {
  const [job, setJob] = useState<ScanJobDTO | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [profileMode, setProfileMode] = useState<ProfileMode>('AUTO');
  const [layers, setLayers] = useState(allLayers);
  const [focusResultId, setFocusResultId] = useState<string | null>(null);
  const [noticedJob, setNoticedJob] = useState<ScanJobDTO | null>(null);
  const { setFocus } = useCopilotFocus();
  const { watchJobId, pendingScan } = useShell();
  const engine = useEngineStatus();
  const jobId = useRef<string | null>(null);
  const seenScan = useRef(0);
  const lastResultsRefresh = useRef(0);
  const jobFocusId = job?.id ?? null;
  const jobFocusLabel = job ? pathLabel(job.targetPath) : null;

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
    if (!watchJobId || watchJobId === jobId.current) return;
    jobId.current = watchJobId;
    setProgress(null);
    setMessage(null);
    void window.cybersoc.scan
      .getJob(watchJobId)
      .then((current) => {
        if (jobId.current === current.id) {
          setJob(current);
          setRefreshToken((value) => value + 1);
        }
      })
      .catch(() => setMessage('No se pudo abrir el escaneo del plan.'));
  }, [watchJobId]);

  useEffect(() => {
    if (!jobFocusId || !jobFocusLabel) return;
    setFocus({ kind: 'JOB', jobId: jobFocusId, label: jobFocusLabel });
  }, [jobFocusId, jobFocusLabel, setFocus]);

  useEffect(() => {
    const stopProgress = window.cybersoc.scan.onProgress((update) => {
      if (update.jobId !== jobId.current) return;
      setProgress(update);
      const now = Date.now();
      if (now - lastResultsRefresh.current >= 1000) {
        lastResultsRefresh.current = now;
        setRefreshToken((value) => value + 1);
      }
    });
    const stopFinished = window.cybersoc.scan.onFinished((finished) => {
      if (finished.id !== jobId.current) return;
      setJob(finished);
      setProgress((current) =>
        current
          ? { ...current, status: finished.status, discoveryDone: true }
          : current,
      );
      setRefreshToken((value) => value + 1);
    });
    return () => {
      stopProgress();
      stopFinished();
    };
  }, []);

  const jobKey = job?.id ?? null;
  const jobStatus = job?.status ?? null;
  useEffect(() => {
    if (!jobKey || !jobStatus || !activeStatuses.has(jobStatus)) return;
    const timer = window.setInterval(() => {
      void window.cybersoc.scan
        .getJob(jobKey)
        .then((current) => {
          if (jobId.current === current.id) setJob(current);
        })
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [jobKey, jobStatus]);

  const start = useCallback(
    async (kind: ScanTarget['kind']) => {
      setMessage(null);
      setBusy(true);
      try {
        const path =
          kind === 'FOLDER'
            ? await window.cybersoc.dialog.selectFolder()
            : await window.cybersoc.dialog.selectFile();
        if (!path) return;
        const started = await window.cybersoc.scan.start({
          kind,
          path,
          profile: profileMode === 'AUTO' ? 'AUTO' : customProfile(layers),
        });
        jobId.current = started.jobId;
        setProgress(null);
        setJob(await window.cybersoc.scan.getJob(started.jobId));
        setRefreshToken((value) => value + 1);
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : 'No se pudo iniciar el escaneo.',
        );
      } finally {
        setBusy(false);
      }
    },
    [layers, profileMode],
  );

  useEffect(() => {
    if (!pendingScan || pendingScan.nonce === seenScan.current) return;
    seenScan.current = pendingScan.nonce;
    void start(pendingScan.kind);
  }, [pendingScan, start]);

  useEffect(() => {
    let active = true;
    void window.cybersoc.scan
      .listJobsPage({ offset: 0, limit: 20 })
      .then((page) => {
        if (!active) return;
        const current = page.items.find((item) =>
          activeStatuses.has(item.status),
        );
        setNoticedJob(current ?? null);
      })
      .catch(() => {
        if (active) setNoticedJob(null);
      });
    return () => {
      active = false;
    };
  }, []);

  async function cancel() {
    if (!job) return;
    setBusy(true);
    try {
      await window.cybersoc.scan.cancel(job.id);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'No se pudo cancelar el escaneo.',
      );
    } finally {
      setBusy(false);
    }
  }

  const running = job ? activeStatuses.has(job.status) : false;

  const otherActive =
    noticedJob && noticedJob.id !== job?.id ? noticedJob : null;

  return (
    <main className="wide">
      <PageHeader
        eyebrow="Escaneo"
        title="Analizar archivos"
        description="Elige un archivo o una carpeta con el selector del sistema. El perfil no cambia las reglas del motor: solo indica qué capas se piden."
        meta={
          <p className="hint">
            {engineHeadline(engine)}
            {' · '}
            {running && job ? (
              <StatusBadge tone={jobTone(job.status)}>
                Análisis en curso: {jobStatusLabel(job.status)}
              </StatusBadge>
            ) : (
              'No hay un análisis abierto en esta pantalla.'
            )}
          </p>
        }
        actions={
          <button
            type="button"
            disabled={!running || busy}
            data-testid="cancel-scan"
            onClick={() => void cancel()}
          >
            {job?.status === 'CANCELLING' ? 'Cancelando…' : 'Cancelar'}
          </button>
        }
      />
      <div className="choice-grid">
        <article className="choice-card">
          <span className="choice-icon">
            <FileIcon />
          </span>
          <h2>Analizar archivo</h2>
          <p>Abre el selector nativo y envía un solo archivo al motor.</p>
          <button
            type="button"
            className="primary"
            disabled={busy || running}
            data-testid="scan-file"
            onClick={() => void start('FILE')}
          >
            Escanear archivo
          </button>
        </article>
        <article className="choice-card">
          <span className="choice-icon">
            <FolderIcon />
          </span>
          <h2>Analizar carpeta</h2>
          <p>
            Recorre el directorio con la pila del programa y analiza la cola de
            archivos.
          </p>
          <button
            type="button"
            disabled={busy || running}
            data-testid="scan-folder"
            onClick={() => void start('FOLDER')}
          >
            Escanear carpeta
          </button>
        </article>
      </div>
      <ProfileSelector
        mode={profileMode}
        selected={layers}
        onMode={setProfileMode}
        onToggle={(layer) =>
          setLayers((current) => toggleLayer(current, layer))
        }
      />
      <details className="advanced">
        <summary>Cómo se ordena el análisis</summary>
        <p>
          La carpeta se recorre con una pila y los archivos esperan en una cola
          FIFO. Esta pantalla no recibe la lista de rutas pendientes, así que no
          dibuja una cola en vivo. Si el motor guarda el pico de la cola o de la
          pila, aparece en el detalle del trabajo.
        </p>
      </details>
      {otherActive && (
        <section className="panel" data-testid="scan-recorded-active">
          <h2>Registro sin terminar</h2>
          <p>
            {otherActive.targetPath} · {jobStatusLabel(otherActive.status)}. Es
            el análisis más reciente guardado con estado sin terminar. No
            confirma que el motor lo esté ejecutando ahora.
          </p>
          <button
            type="button"
            onClick={() => {
              jobId.current = otherActive.id;
              setJob(otherActive);
              setProgress(null);
              setRefreshToken((value) => value + 1);
            }}
          >
            Mostrar este registro
          </button>
        </section>
      )}
      {message && <p role="alert">{message}</p>}
      {job && (
        <>
          <ProgressPanel
            progress={progress}
            job={job}
            onOpenTopRisk={(item) => {
              setFocusResultId(item.resultId);
              setFocus({
                kind: 'RESULT',
                resultId: item.resultId,
                label: item.fileName,
              });
            }}
          />
          <JobDetail job={job} elapsedMs={progress?.elapsedMs ?? null} />
          <JobSummaryCard
            jobId={job.id}
            refreshToken={refreshToken}
            onOpenResult={setFocusResultId}
          />
          <ResultsTable
            jobId={job.id}
            profileJson={job.profileJson}
            refreshToken={refreshToken}
            focusResultId={focusResultId}
            onSelectResult={chooseResult}
          />
        </>
      )}
    </main>
  );
}
