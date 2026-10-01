import { describe, expect, it, vi } from 'vitest';
import { ZoneClassifier } from '../src/core/zones/ZoneClassifier';
import { resolveZoneRoots } from '../src/main/zone-paths';

const paths = {
  downloads: 'D:\\Usuarios\\Peña\\Descargas',
  desktop: 'D:\\Usuarios\\Peña\\Escritorio',
  documents: 'D:\\Usuarios\\Peña\\Documentos',
  temp: 'D:\\Usuarios\\Peña\\AppData\\Local\\Temp',
  appData: 'D:\\Usuarios\\Peña\\AppData\\Roaming',
};
const roots = resolveZoneRoots((name) => paths[name], {
  LOCALAPPDATA: 'D:\\Usuarios\\Peña\\AppData\\Local',
  APPDATA: paths.appData,
  TEMP: paths.temp,
  ProgramFiles: 'D:\\Program Files',
  'ProgramFiles(x86)': 'D:\\Program Files (x86)',
  SystemRoot: 'D:\\Windows',
});
describe('ZoneClassifier: rutas reales inyectadas y prefijo más largo', () => {
  it.each([
    [`${paths.downloads}\\a.exe`, 'DESCARGAS'],
    [`${paths.desktop}\\a`, 'ESCRITORIO'],
    [`${paths.documents}\\a`, 'DOCUMENTOS'],
    [`${paths.temp}\\a`, 'TEMPORALES'],
    ['d:/USUARIOS/peña/AppData/Local/TEMP/hola.txt', 'TEMPORALES'],
    ['D:\\Usuarios\\Peña\\AppData\\Local\\TempOtro\\a', 'DATOS_APPS'],
    [`${paths.appData}\\a`, 'DATOS_APPS'],
    ['D:\\Program Files\\a', 'PROGRAMAS'],
    ['D:\\Program Files (x86)\\a', 'PROGRAMAS'],
    ['D:\\Windows\\System32\\a', 'SISTEMA'],
    ['D:\\WindowsOtro\\a', 'OTRA'],
    ['D:\\otra\\a', 'OTRA'],
  ])('%s → %s', async (path, zone) => {
    expect(
      await new ZoneClassifier(roots, async () => ({
        driveType: 'FIXED',
      })).classify(path),
    ).toBe(zone);
  });
  it('unidad extraíble simulada prima sobre carpetas redirigidas y se consulta una vez', async () => {
    const drive = vi.fn(async () => ({ driveType: 'REMOVABLE' as const }));
    const classifier = new ZoneClassifier(roots, drive);
    expect(await classifier.classify(`${paths.documents}\\a`)).toBe(
      'EXTRAIBLE',
    );
    expect(await classifier.classify(`${paths.temp}\\b`)).toBe('EXTRAIBLE');
    expect(drive).toHaveBeenCalledExactlyOnceWith('d:\\');
  });
  it.each(['NETWORK', 'UNKNOWN', 'CDROM'] as const)(
    '%s no se convierte en EXTRAIBLE',
    async (driveType) => {
      expect(
        await new ZoneClassifier(roots, async () => ({ driveType })).classify(
          'E:\\a',
        ),
      ).toBe('OTRA');
    },
  );
  it('soporta rutas UNC redirigidas, raíz de unidad y fronteras por segmento', async () => {
    const classifier = new ZoneClassifier(
      [
        { path: '\\\\server\\share\\docs', zone: 'DOCUMENTOS' },
        { path: 'C:\\', zone: 'SISTEMA' },
        { path: 'C:\\Win', zone: 'TEMPORALES' },
      ],
      async () => ({ driveType: 'FIXED' }),
    );
    expect(await classifier.classify('C:\\Windows\\a')).toBe('SISTEMA');
    expect(await classifier.classify('C:\\Win\\a')).toBe('TEMPORALES');
    expect(await classifier.classify('\\\\server\\share\\docs\\a')).toBe(
      'DOCUMENTOS',
    );
  });
  it('no cachea fallos de fs.driveInfo', async () => {
    const drive = vi
      .fn()
      .mockRejectedValueOnce(new Error('desconectado'))
      .mockResolvedValue({ driveType: 'REMOVABLE' });
    const classifier = new ZoneClassifier([], drive);
    await expect(classifier.classify('E:\\a')).rejects.toThrow('desconectado');
    expect(await classifier.classify('E:\\a')).toBe('EXTRAIBLE');
    expect(drive).toHaveBeenCalledTimes(2);
  });
});
