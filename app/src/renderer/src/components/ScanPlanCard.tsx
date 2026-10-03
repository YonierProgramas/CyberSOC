import { useState } from 'react';
import type { ScanPlanCardDTO } from '../../../shared/ipc';
import { useShell } from '../navigation/shell';
import { zoneLabel } from '../scan/format';
import { ModalDialog } from './ModalDialog';
import { PlainText } from './PlainText';

export function ScanPlanCard({
  plan,
  open,
  onOpen,
  onClose,
}: {
  plan: ScanPlanCardDTO;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { watchScan } = useShell();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const destinations = plan.targets.flatMap((target) =>
    target.paths.map((path) => ({
      zoneId: target.zoneId,
      driveId: target.driveId,
      path,
    })),
  );
  const first = destinations[0];

  async function confirm() {
    if (!first || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      // El plan solo se propone. scan.start corre aquí, después de confirmar.
      const started = await window.cybersoc.scan.start({
        kind: 'FOLDER',
        path: first.path,
        profile: plan.profile,
      });
      onClose();
      watchScan(started.jobId);
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

  return (
    <section className="copilot-card" data-testid="copilot-plan">
      <h3>Plan de escaneo</h3>
      <ul>
        {destinations.map((target) => (
          <li
            key={`${target.zoneId}:${target.driveId ?? ''}:${target.path}`}
            data-testid="copilot-plan-target"
          >
            {zoneLabel(target.zoneId)}
            {target.driveId ? ` · ${target.driveId}` : ''}
            <span className="path">{target.path}</span>
          </li>
        ))}
      </ul>
      <ul>
        {plan.profile.layers.map((layer) => {
          const why = plan.layerRationale.find((item) => item.layer === layer);
          return (
            <li key={layer} data-testid="copilot-plan-layer">
              <p>{layer}</p>
              {why && (
                <>
                  <p className="eyebrow">Generado por IA</p>
                  <PlainText text={why.why} />
                </>
              )}
            </li>
          );
        })}
      </ul>
      <p>
        Ocultos: {plan.profile.includeHidden ? 'sí' : 'no'} · Tamaño máximo:{' '}
        {plan.profile.maxFileSizeMB} MB
      </p>
      <div data-testid="copilot-plan-rationale">
        <p className="eyebrow">Generado por IA</p>
        <PlainText text={plan.rationale} />
      </div>
      <button type="button" data-testid="copilot-plan-execute" onClick={onOpen}>
        Ejecutar plan
      </button>
      {open && (
        <ModalDialog
          testId="copilot-plan-dialog"
          titleId="copilot-plan-dialog-title"
          title="Confirmar plan de escaneo"
        >
          <p>
            Al confirmar se analiza la primera carpeta con el perfil del plan.
            Hasta entonces no se inicia ningún escaneo.
          </p>
          {destinations.length > 1 && (
            <p>
              El plan nombra varias carpetas. Solo puede correr un escaneo a la
              vez, así que se inicia la primera.
            </p>
          )}
          {first ? (
            <p className="path" data-testid="copilot-plan-confirm-path">
              {first.path}
            </p>
          ) : (
            <p>El plan no trae carpetas para escanear.</p>
          )}
          <p>Capas: {plan.profile.layers.join(', ')}</p>
          {message && <p role="alert">{message}</p>}
          <div className="actions">
            <button type="button" onClick={onClose} disabled={busy}>
              Cancelar
            </button>
            <button
              type="button"
              data-testid="copilot-plan-confirm"
              disabled={busy || !first}
              onClick={() => void confirm()}
            >
              Confirmar e iniciar
            </button>
          </div>
        </ModalDialog>
      )}
    </section>
  );
}
