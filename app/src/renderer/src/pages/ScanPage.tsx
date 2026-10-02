import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanJobDTO, ScanProgress, ScanTarget } from '../../../shared/ipc';
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
import { pathLabel, useCopilotFocus } from '../copilot/focus';

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
  const { setFocus } = useCopilotFocus();
  const jobId = useRef<string | null>(null);
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

  async function start(kind: ScanTarget['kind']) {
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
  }

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

  return (
    <main className="wide">
      <p className="eyebrow">Escaneo</p>
      <h1>Analizar archivos</h1>
      <div className="actions">
        <button
          type="button"
          disabled={busy || running}
          data-testid="scan-folder"
          onClick={() => void start('FOLDER')}
        >
          Escanear carpeta
        </button>
        <button
          type="button"
          disabled={busy || running}
          data-testid="scan-file"
          onClick={() => void start('FILE')}
        >
          Escanear archivo
        </button>
        <button
          type="button"
          disabled={!running || busy}
          data-testid="cancel-scan"
          onClick={() => void cancel()}
        >
          {job?.status === 'CANCELLING' ? 'Cancelando…' : 'Cancelar'}
        </button>
      </div>
      <ProfileSelector
        mode={profileMode}
        selected={layers}
        onMode={setProfileMode}
        onToggle={(layer) =>
          setLayers((current) => toggleLayer(current, layer))
        }
      />
      {message && <p role="alert">{message}</p>}
      {job && (
        <>
          <ProgressPanel progress={progress} job={job} />
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
