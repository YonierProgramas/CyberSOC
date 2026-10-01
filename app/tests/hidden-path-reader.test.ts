import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { HiddenPathReader } from '../src/main/HiddenPathReader';

describe.skipIf(process.platform !== 'win32')(
  'atributos Hidden reales de Windows (solo fixtures temporales)',
  () => {
    it('consulta nombres Unicode, ocultos y padres ocultos sin ejecutar texto de rutas', async () => {
      // AppData (tmpdir habitual) ya es oculto: usar un fixture temporal bajo app.
      const root = await mkdtemp(join(process.cwd(), '.cybersoc-hidden-'));
      const directory = join(root, 'carpeta-ñ');
      const plain = join(root, "niño '$() archivo.txt");
      const hidden = join(root, 'oculto.txt');
      const child = join(directory, 'visible.txt');
      const reader = new HiddenPathReader();
      try {
        await mkdir(directory);
        await Promise.all(
          [plain, hidden, child].map((path) =>
            writeFile(path, 'fixture inofensivo'),
          ),
        );
        await promisify(execFile)('attrib.exe', ['+H', hidden], {
          windowsHide: true,
        });
        await promisify(execFile)('attrib.exe', ['+H', directory], {
          windowsHide: true,
        });
        expect(await reader.isHidden(plain)).toBe(false);
        expect(await reader.isHidden(hidden)).toBe(true);
        expect(await reader.isHidden(child)).toBe(true);
        expect(await reader.isHidden(plain)).toBe(false);
        expect(await reader.isHidden(join(root, 'desaparecido.txt'))).toBe(
          false,
        );
      } finally {
        reader.close();
        await rm(root, { recursive: true, force: true });
      }
      await expect(reader.isHidden(plain)).rejects.toThrow('cerrada');
    }, 20_000);
  },
);
