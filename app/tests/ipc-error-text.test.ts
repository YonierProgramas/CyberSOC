import { describe, expect, it } from 'vitest';
import { ipcErrorText } from '../src/renderer/src/ipc/errors';

describe('ipcErrorText', () => {
  it('removes the English prefix Electron adds to errors from main handlers', () => {
    const error = new Error(
      "Error invoking remote method 'scan:start': Error: Ya hay un escaneo activo.",
    );
    expect(ipcErrorText(error, 'fallback')).toBe('Ya hay un escaneo activo.');
  });

  it('removes the prefix for a named error class as well', () => {
    const error = new Error(
      "Error invoking remote method 'reports:export': TypeError: Destino inválido.",
    );
    expect(ipcErrorText(error, 'fallback')).toBe('Destino inválido.');
  });

  it('keeps a message that has no Electron prefix unchanged', () => {
    const error = new Error('No se pudo completar la acción.');
    expect(ipcErrorText(error, 'fallback')).toBe(
      'No se pudo completar la acción.',
    );
  });

  it('uses the fallback for values that are not errors or have no message', () => {
    expect(ipcErrorText('failure', 'fallback')).toBe('fallback');
    expect(ipcErrorText(undefined, 'fallback')).toBe('fallback');
    expect(ipcErrorText(new Error(''), 'fallback')).toBe('fallback');
  });
});
