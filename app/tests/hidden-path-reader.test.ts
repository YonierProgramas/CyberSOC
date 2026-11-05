import {
  execFile,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  HiddenPathReader,
  hiddenPathScript,
} from '../src/main/HiddenPathReader';

describe('script de atributos', () => {
  it('no usa cmdlets: no depende de la autocarga de módulos de PowerShell', () => {
    // Un cmdlet tiene forma Verbo-Nombre (ConvertFrom-Json, Get-Item…). Sin caché de
    // módulos, su primera llamada podía tardar más que el plazo de la consulta.
    expect(hiddenPathScript).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/);
    expect(hiddenPathScript).toContain('FromBase64String');
  });
});

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
      const started = performance.now();
      const events: { event: string; ms: number; code?: string | number }[] =
        [];
      let stderrBytes = 0;
      let stdoutBytes = 0;
      const record = (event: string, code?: string | number) => {
        // Lista acotada de eventos: O(1) por inserción y memoria máxima constante.
        // Solo metadatos; nunca volcar rutas, stderr o variables del proceso.
        if (events.length < 12)
          events.push({
            event,
            ms: Math.round(performance.now() - started),
            code,
          });
      };
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
        const firstQuery = reader.isHidden(plain);
        // Observación de la instancia real, sin reemplazar spawn ni sus streams.
        // isHidden crea el proceso antes de devolver la promesa de respuesta.
        const processChild = Reflect.get(reader, 'child') as
          ChildProcessWithoutNullStreams | undefined;
        processChild?.once('spawn', () => record('spawn'));
        processChild?.once('error', (error: NodeJS.ErrnoException) =>
          record('error', error.code),
        );
        processChild?.once('exit', (code) => record('exit', code ?? undefined));
        processChild?.stdout.on('data', (chunk: Buffer) => {
          if (stdoutBytes === 0) record('first-stdout');
          stdoutBytes += chunk.length;
        });
        processChild?.stderr.on('data', (chunk: Buffer) => {
          if (stderrBytes === 0) record('first-stderr');
          stderrBytes += chunk.length;
        });
        expect(await firstQuery).toBe(false);
        expect(await reader.isHidden(hidden)).toBe(true);
        expect(await reader.isHidden(child)).toBe(true);
        expect(await reader.isHidden(plain)).toBe(false);
        expect(await reader.isHidden(join(root, 'desaparecido.txt'))).toBe(
          false,
        );
      } catch (error) {
        console.error(
          'HIDDEN_PATH_DIAGNOSTIC',
          JSON.stringify({
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            elapsedMs: Math.round(performance.now() - started),
            stdoutBytes,
            stderrBytes,
            events,
          }),
        );
        throw error;
      } finally {
        reader.close();
        await rm(root, { recursive: true, force: true });
      }
      await expect(reader.isHidden(plain)).rejects.toThrow('cerrada');
    }, 20_000);
  },
);
