import { useState } from 'react';
import type { ScanResultDTO } from '../../../shared/ipc';
import { ModalDialog } from './ModalDialog';
import { errorText, quarantineReason } from '../quarantine/format';
import { quarantineApi, QUARANTINE_UNAVAILABLE } from '../quarantine/types';
import { verdictLabel } from '../scan/format';

export function QuarantineButton({
  resultId,
  path,
  verdict,
  onDone,
}: {
  resultId: string;
  path: string;
  verdict: ScanResultDTO['verdict'];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const eligible = verdict === 'DETECTED' || verdict === 'SUSPICIOUS';
  const reason = quarantineReason(eligible ? verdictLabel(verdict) : verdict);
  if (!eligible) return null;

  async function confirm() {
    const api = quarantineApi();
    if (!api) {
      setMessage(QUARANTINE_UNAVAILABLE);
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await api.quarantine(resultId);
      setOpen(false);
      onDone();
    } catch (error) {
      setMessage(errorText(error));
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="quarantine-file"
        onClick={() => setOpen(true)}
      >
        Poner en cuarentena
      </button>
      {message && <p role="alert">{message}</p>}
      {open && (
        <ModalDialog
          testId="quarantine-dialog"
          titleId="quarantine-dialog-title"
          title="Poner en cuarentena"
        >
          <p>El archivo saldrá de su ruta y quedará cifrado en la bóveda.</p>
          <p>
            Ruta:{' '}
            <span className="path" data-testid="quarantine-path">
              {path}
            </span>
          </p>
          <p>
            Motivo: <span data-testid="quarantine-reason">{reason}</span>
          </p>
          <div className="actions">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancelar
            </button>
            <button
              type="button"
              data-testid="quarantine-confirm"
              disabled={busy}
              onClick={() => void confirm()}
            >
              Confirmar cuarentena
            </button>
          </div>
        </ModalDialog>
      )}
    </>
  );
}
