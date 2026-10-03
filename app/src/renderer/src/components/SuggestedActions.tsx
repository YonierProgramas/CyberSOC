import { useState } from 'react';
import type {
  AssistantActionDTO,
  ReportExportQuery,
} from '../../../shared/ipc';
import { useShell } from '../navigation/shell';
import { quarantineApi, QUARANTINE_UNAVAILABLE } from '../quarantine/types';
import { ModalDialog } from './ModalDialog';

const labels: Record<AssistantActionDTO['action'], string> = {
  OPEN_RESULT: 'Abrir resultado',
  QUARANTINE: 'Poner en cuarentena',
  ANALYZE_WITH_AI: 'Analizar con IA',
  OPEN_QUARANTINE: 'Abrir cuarentena',
  EXPORT_REPORT: 'Exportar reporte',
  RUN_SCAN_PLAN: 'Ejecutar plan',
};

export function SuggestedActions({
  actions,
  reportDraftId,
  hasPlan,
  onRunPlan,
}: {
  actions: readonly AssistantActionDTO[];
  reportDraftId: string | null;
  hasPlan: boolean;
  onRunPlan: () => void;
}) {
  const { openReference, setView } = useShell();
  const [pending, setPending] = useState<AssistantActionDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialogMessage, setDialogMessage] = useState<string | null>(null);

  if (actions.length === 0) return null;

  function close() {
    setPending(null);
    setDialogMessage(null);
    setBusy(false);
  }

  async function run(task: () => Promise<string>) {
    setBusy(true);
    setDialogMessage(null);
    try {
      const text = await task();
      close();
      setNotice(text);
    } catch (error) {
      setDialogMessage(
        error instanceof Error
          ? error.message
          : 'No se pudo completar la acción.',
      );
      setBusy(false);
    }
  }

  async function confirm(action: AssistantActionDTO) {
    const targetId = action.targetId;
    if (action.action === 'RUN_SCAN_PLAN') {
      close();
      if (hasPlan) onRunPlan();
      return;
    }
    if (action.action === 'OPEN_RESULT' && targetId) {
      await run(async () => {
        openReference({ type: 'result', id: targetId });
        return 'Se abrió el resultado citado.';
      });
      return;
    }
    if (action.action === 'OPEN_QUARANTINE') {
      await run(async () => {
        setView('quarantine');
        return 'Se abrió la cuarentena.';
      });
      return;
    }
    if (action.action === 'QUARANTINE' && targetId) {
      await run(async () => {
        const api = quarantineApi();
        if (!api) throw new Error(QUARANTINE_UNAVAILABLE);
        await api.quarantine(targetId);
        return 'El archivo quedó en cuarentena.';
      });
      return;
    }
    if (action.action === 'ANALYZE_WITH_AI' && targetId) {
      await run(async () => {
        await window.cybersoc.scan.analyzeNow(targetId);
        return 'El análisis con IA quedó en cola.';
      });
    }
  }

  async function exportReport(format: ReportExportQuery['format']) {
    const draftId = pending?.targetId || reportDraftId;
    if (!draftId) return;
    await run(async () => {
      const result = await window.cybersoc.reports.export({
        reportDraftId: draftId,
        format,
      });
      return result.status === 'SAVED'
        ? 'El reporte se guardó.'
        : 'Exportación cancelada.';
    });
  }

  const needsTarget =
    pending !== null &&
    pending.action !== 'OPEN_QUARANTINE' &&
    pending.action !== 'RUN_SCAN_PLAN' &&
    pending.action !== 'EXPORT_REPORT' &&
    !pending.targetId;

  return (
    <div className="actions" data-testid="copilot-actions">
      {actions.map((action, index) => (
        <button
          key={`${action.action}:${action.targetId ?? ''}:${index}`}
          type="button"
          data-testid="copilot-action"
          data-action={action.action}
          onClick={() => {
            setNotice(null);
            if (action.action === 'RUN_SCAN_PLAN' && hasPlan) {
              onRunPlan();
              return;
            }
            setPending(action);
          }}
        >
          {labels[action.action]}
        </button>
      ))}
      {notice && <p data-testid="copilot-action-notice">{notice}</p>}
      {pending && (
        <ModalDialog
          testId="copilot-action-dialog"
          titleId="copilot-action-dialog-title"
          title={labels[pending.action]}
        >
          <p>
            Esta acción no se ejecuta sola. Confírmala si quieres continuar.
          </p>
          {pending.action === 'RUN_SCAN_PLAN' && !hasPlan && (
            <p>No hay un plan válido para ejecutar.</p>
          )}
          {needsTarget && <p>Esta acción no trae un destino.</p>}
          {dialogMessage && <p role="alert">{dialogMessage}</p>}
          <div className="actions">
            <button
              type="button"
              data-testid="copilot-action-cancel"
              onClick={close}
              disabled={busy}
            >
              Cancelar
            </button>
            {pending.action === 'EXPORT_REPORT' ? (
              <>
                <button
                  type="button"
                  data-testid="copilot-action-export-html"
                  disabled={busy || !(pending.targetId || reportDraftId)}
                  onClick={() => void exportReport('html')}
                >
                  Confirmar HTML
                </button>
                <button
                  type="button"
                  data-testid="copilot-action-export-csv"
                  disabled={busy || !(pending.targetId || reportDraftId)}
                  onClick={() => void exportReport('csv')}
                >
                  Confirmar CSV
                </button>
                <button
                  type="button"
                  data-testid="copilot-action-export-json"
                  disabled={busy || !(pending.targetId || reportDraftId)}
                  onClick={() => void exportReport('json')}
                >
                  Confirmar JSON
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="copilot-action-confirm"
                disabled={
                  busy ||
                  needsTarget ||
                  (pending.action === 'RUN_SCAN_PLAN' && !hasPlan)
                }
                onClick={() => void confirm(pending)}
              >
                Confirmar
              </button>
            )}
          </div>
        </ModalDialog>
      )}
    </div>
  );
}
