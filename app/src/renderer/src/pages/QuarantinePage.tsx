import { useEffect, useState } from 'react';
import { ModalDialog } from '../components/ModalDialog';
import {
  errorText,
  fileNameOf,
  formatWhen,
  quarantineStatusLabel,
  quarantineWhen,
} from '../quarantine/format';
import {
  quarantineApi,
  QUARANTINE_UNAVAILABLE,
  type QuarantineItemDTO,
} from '../quarantine/types';

export function QuarantinePage() {
  const [items, setItems] = useState<QuarantineItemDTO[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [restoreItem, setRestoreItem] = useState<QuarantineItemDTO | null>(
    null,
  );
  const [deleteItem, setDeleteItem] = useState<QuarantineItemDTO | null>(null);

  async function load() {
    const api = quarantineApi();
    if (!api) {
      setMessage(QUARANTINE_UNAVAILABLE);
      setItems([]);
      return;
    }
    setItems(await api.list());
    setMessage(null);
  }

  useEffect(() => {
    let active = true;
    void load().catch((error: unknown) => {
      if (active) setMessage(errorText(error));
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="wide">
      <h1>Cuarentena</h1>
      <p>
        Archivos aislados en la bóveda. Restaurar y eliminar piden confirmación.
      </p>
      {message && <p role="alert">{message}</p>}
      {items.length === 0 ? (
        <p>No hay archivos en cuarentena.</p>
      ) : (
        <div className="table-wrap">
          <table data-testid="quarantine-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Ruta original</th>
                <th>SHA-256</th>
                <th>Motivo</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} data-testid="quarantine-row">
                  <td>{fileNameOf(item.originalPath)}</td>
                  <td className="path">{item.originalPath}</td>
                  <td>
                    <code>{item.sha256}</code>
                  </td>
                  <td>{item.reason}</td>
                  <td>{formatWhen(quarantineWhen(item))}</td>
                  <td>{quarantineStatusLabel(item.status)}</td>
                  <td className="actions">
                    <button
                      type="button"
                      data-testid="quarantine-restore"
                      disabled={item.status !== 'QUARANTINED'}
                      onClick={() => setRestoreItem(item)}
                    >
                      Restaurar
                    </button>
                    <button
                      type="button"
                      data-testid="quarantine-delete"
                      disabled={item.status !== 'QUARANTINED'}
                      onClick={() => setDeleteItem(item)}
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {restoreItem && (
        <RestoreDialog
          item={restoreItem}
          onClose={() => setRestoreItem(null)}
          onDone={() => {
            setRestoreItem(null);
            void load().catch((error: unknown) => setMessage(errorText(error)));
          }}
          onError={(text) => setMessage(text)}
        />
      )}
      {deleteItem && (
        <DeleteDialog
          item={deleteItem}
          onClose={() => setDeleteItem(null)}
          onDone={() => {
            setDeleteItem(null);
            void load().catch((error: unknown) => setMessage(errorText(error)));
          }}
          onError={(text) => setMessage(text)}
        />
      )}
    </main>
  );
}

function RestoreDialog({
  item,
  onClose,
  onDone,
  onError,
}: {
  item: QuarantineItemDTO;
  onClose: () => void;
  onDone: () => void;
  onError: (text: string) => void;
}) {
  const [trustHash, setTrustHash] = useState(false);
  const [originalExists, setOriginalExists] = useState(false);
  const [targetPath, setTargetPath] = useState('');
  const [detectedStep, setDetectedStep] = useState(false);
  const [busy, setBusy] = useState(false);
  const detected = item.verdictSnapshot === 'DETECTED';

  async function restore() {
    const api = quarantineApi();
    if (!api) {
      onError(QUARANTINE_UNAVAILABLE);
      onClose();
      return;
    }
    setBusy(true);
    try {
      await api.restore(item.id, {
        trustHash,
        ...(originalExists ? { targetPath: targetPath.trim() } : {}),
      });
      onDone();
    } catch (error) {
      onError(errorText(error));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  if (detectedStep) {
    return (
      <ModalDialog
        testId="quarantine-restore-detected-dialog"
        titleId="quarantine-restore-detected-title"
        title="Segunda confirmación"
      >
        <p>
          Este archivo estaba <strong>detectado</strong>. Restaurar lo devuelve
          al disco. Confirma solo si estás seguro.
        </p>
        <p className="path" data-testid="quarantine-restore-path">
          {item.originalPath}
        </p>
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            data-testid="quarantine-restore-detected-confirm"
            disabled={busy}
            onClick={() => void restore()}
          >
            Restaurar de todas formas
          </button>
        </div>
      </ModalDialog>
    );
  }

  const needsPath = originalExists && targetPath.trim() === '';
  return (
    <ModalDialog
      testId="quarantine-restore-dialog"
      titleId="quarantine-restore-title"
      title="Restaurar archivo"
    >
      <p>
        Se devolverá una copia verificada. Nunca se sobrescribe un archivo
        existente.
      </p>
      <p className="path" data-testid="quarantine-restore-path">
        {item.originalPath}
      </p>
      <label>
        <span>
          <input
            type="checkbox"
            data-testid="quarantine-trust-hash"
            checked={trustHash}
            onChange={(event) => setTrustHash(event.target.checked)}
          />{' '}
          Confiar en este hash
        </span>
      </label>
      <label>
        <span>
          <input
            type="checkbox"
            data-testid="quarantine-original-exists"
            checked={originalExists}
            onChange={(event) => setOriginalExists(event.target.checked)}
          />{' '}
          La ruta original ya existe
        </span>
      </label>
      {originalExists && (
        <label>
          Otra ruta
          <input
            data-testid="quarantine-target-path"
            value={targetPath}
            onChange={(event) => setTargetPath(event.target.value)}
            placeholder="Ruta completa de destino"
          />
        </label>
      )}
      <div className="actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
        <button
          type="button"
          data-testid="quarantine-restore-confirm"
          disabled={busy || needsPath}
          onClick={() => {
            if (detected) setDetectedStep(true);
            else void restore();
          }}
        >
          Restaurar
        </button>
      </div>
    </ModalDialog>
  );
}

function DeleteDialog({
  item,
  onClose,
  onDone,
  onError,
}: {
  item: QuarantineItemDTO;
  onClose: () => void;
  onDone: () => void;
  onError: (text: string) => void;
}) {
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);

  async function remove() {
    const api = quarantineApi();
    if (!api) {
      onError(QUARANTINE_UNAVAILABLE);
      onClose();
      return;
    }
    setBusy(true);
    try {
      await api.delete(item.id);
      onDone();
    } catch (error) {
      onError(errorText(error));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      testId="quarantine-delete-dialog"
      titleId="quarantine-delete-title"
      title="Eliminar de la cuarentena"
    >
      <p>
        Se borra solo la copia de la bóveda. El registro queda como eliminado.
        Escribe ELIMINAR para confirmar.
      </p>
      <p className="path">{fileNameOf(item.originalPath)}</p>
      <label>
        Confirmación
        <input
          data-testid="quarantine-delete-phrase"
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
          autoComplete="off"
        />
      </label>
      <div className="actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
        <button
          type="button"
          data-testid="quarantine-delete-confirm"
          disabled={busy || phrase !== 'ELIMINAR'}
          onClick={() => void remove()}
        >
          Eliminar
        </button>
      </div>
    </ModalDialog>
  );
}
