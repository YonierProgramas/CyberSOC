import { describe, expect, it } from 'vitest';
import { isPermissionAllowed } from '../src/main/permissions';

describe('window web permissions (B-06)', () => {
  it('only grants clipboard write to copy a hash', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write')).toBe(true);
  });

  it('denies camera, microphone, location, notifications and clipboard read', () => {
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
