import { BrowserWindow } from 'electron';
import { join } from 'node:path';

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: 'CyberSOC Defender',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  });

  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) =>
    event.preventDefault(),
  );
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.once('ready-to-show', () => window.show());

  return window;
}
