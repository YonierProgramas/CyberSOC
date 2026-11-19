import type {
  CyberSocApi,
  QuarantineItemDTO,
  ScanResultDTO,
} from '../../../shared/ipc';

export const MAX_SECURITY_ALERTS = 20;

export function isThreat(result: ScanResultDTO): boolean {
  return (
    result.status === 'SCANNED' &&
    (result.verdict === 'DETECTED' || result.verdict === 'SUSPICIOUS')
  );
}

export function updateAlerts(
  current: ScanResultDTO[],
  incoming: ScanResultDTO[],
): ScanResultDTO[] {
  let next = current;
  for (const result of incoming) {
    const previous = next.find((item) => item.id === result.id);
    if (!isThreat(result)) {
      if (previous) next = next.filter((item) => item.id !== result.id);
    } else if (previous) {
      next = next.map((item) => (item.id === result.id ? result : item));
    } else {
      next = [result, ...next].slice(0, MAX_SECURITY_ALERTS);
    }
  }
  return next;
}

export function quarantineNotice(
  result: ScanResultDTO,
  items: QuarantineItemDTO[] | null,
): { text: string; canQuarantine: boolean; isolated: boolean } {
  if (!items) {
    return {
      text: 'Estado de cuarentena sin confirmar. Consulta la sección Cuarentena.',
      canQuarantine: false,
      isolated: false,
    };
  }
  // El Core ordena por inserción ascendente. Una copia nueva con la misma
  // ruta/huella no hereda el aislamiento de un resultado anterior.
  const item = [...items]
    .reverse()
    .find((entry) => entry.resultId === result.id);
  const status = item?.status;
  if (status === 'QUARANTINED') {
    return {
      text: 'En cuarentena: el archivo fue aislado en la bóveda cifrada.',
      canQuarantine: false,
      isolated: true,
    };
  }
  if (status === 'PENDING' || status === 'FAILED') {
    return {
      text:
        status === 'PENDING'
          ? 'Cuarentena pendiente de completar. El aislamiento aún no está confirmado.'
          : 'La operación de cuarentena falló. El aislamiento no está confirmado.',
      canQuarantine: false,
      isolated: false,
    };
  }
  if (status === 'DELETED') {
    return {
      text: 'Eliminado de la cuarentena por confirmación del usuario.',
      canQuarantine: false,
      isolated: false,
    };
  }
  if (status === 'RESTORED') {
    return {
      text: 'Restaurado por el usuario: ya no está aislado en cuarentena. Vuelve a escanearlo para revisar su estado actual.',
      canQuarantine: false,
      isolated: false,
    };
  }
  return {
    text: 'Sin cuarentena: este archivo requiere tu confirmación para aislarlo.',
    canQuarantine: true,
    isolated: false,
  };
}

/** Lee resultados nuevos sin depender de la página visible ni del top de puntuación. */
export function watchSecurityAlerts(
  scan: CyberSocApi['scan'],
  onResults: (results: ScanResultDTO[]) => void,
  onError: () => void,
): () => void {
  let active = true;
  let jobId: string | null = null;
  let offset = 0;
  let requested: string | null = null;
  let loading = false;

  async function drain() {
    if (loading) return;
    loading = true;
    try {
      while (active && requested) {
        const target = requested;
        requested = null;
        if (jobId !== target) {
          jobId = target;
          offset = 0;
        }
        let more = true;
        while (active && more) {
          const page = await scan.listResults({
            jobId: target,
            offset,
            limit: 100,
          });
          if (!active) return;
          onResults(page.items);
          offset += page.items.length;
          more = page.items.length > 0 && offset < page.total;
        }
      }
    } catch {
      if (active) onError();
    } finally {
      loading = false;
      if (active && requested) void drain();
    }
  }

  function request(id: string) {
    requested = id;
    void drain();
  }

  const stopProgress = scan.onProgress((progress) => request(progress.jobId));
  const stopFinished = scan.onFinished((job) => request(job.id));
  const stopUpdated = scan.onResultUpdated((update) => {
    void scan.getResult(update.resultId).then(
      (detail) => {
        if (active) onResults([detail.result]);
      },
      () => {
        if (active) onError();
      },
    );
  });
  // Al abrir la app también se recuperan los avisos del último análisis guardado.
  void scan.listJobs(1).then(
    (jobs) => {
      if (active && !jobId && !requested && jobs[0]) request(jobs[0].id);
    },
    () => {
      if (active) onError();
    },
  );
  return () => {
    active = false;
    stopProgress();
    stopFinished();
    stopUpdated();
  };
}
