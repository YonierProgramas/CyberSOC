import { describe, expect, it } from 'vitest';
import { isPermissionAllowed } from '../src/main/permissions';

describe('permisos web de la ventana (B-06)', () => {
  it('solo concede escribir en el portapapeles para copiar un hash', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write')).toBe(true);
  });

  it('niega cámara, micrófono, ubicación, notificaciones y lectura del portapapeles', () => {
    for (const permission of [
      'media',
      'geolocation',
      'notifications',
      'clipboard-read',
      'midi',
      'midiSysex',
      'pointerLock',
      'fullscreen',
      'openExternal',
      'display-capture',
      'hid',
      'serial',
      'usb',
      'fileSystem',
      'window-management',
      'unknown',
      '',
    ])
      expect(isPermissionAllowed(permission), permission).toBe(false);
  });
});
