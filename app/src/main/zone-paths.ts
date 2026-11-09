import { win32 } from 'node:path';
import type { ZoneRoot } from '../core/zones/ZoneClassifier';

/** main injects the user paths; core knows neither Electron nor global variables. */
export function resolveZoneRoots(
  getPath: (
    name: 'downloads' | 'desktop' | 'documents' | 'temp' | 'appData',
  ) => string,
  env: NodeJS.ProcessEnv,
): ZoneRoot[] {
  const roots: ZoneRoot[] = [];
  const add = (zone: ZoneRoot['zone'], path: string | undefined) => {
    if (path && /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(path))
      roots.push({ zone, path });
  };
  // On an exact tie the last entry wins; TEMP is registered last.
  add('SISTEMA', env.SystemRoot ?? env.windir);
  for (const name of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'])
    add('PROGRAMAS', env[name]);
  add('DATOS_APPS', getPath('appData'));
  add('DATOS_APPS', env.APPDATA);
  add('DATOS_APPS', env.LOCALAPPDATA);
  add('DOCUMENTOS', getPath('documents'));
  add('ESCRITORIO', getPath('desktop'));
  add('DESCARGAS', getPath('downloads'));
  add('TEMPORALES', getPath('temp'));
  if (env.LOCALAPPDATA) add('TEMPORALES', win32.join(env.LOCALAPPDATA, 'Temp'));
  add('TEMPORALES', env.TEMP);
  return roots;
}
