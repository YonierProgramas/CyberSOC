import * as fs from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { QuarantineItem } from '../../src/core/persistence/QuarantineRepository';
import { exists, validatePath } from '../../src/core/quarantine/paths';
import { QuarantineHarness, sha, type Seeded } from './harness';

vi.setConfig({ testTimeout: 20_000 });

// Un solo ítem en cuarentena sirve para todos los ataques: cada intento rechazado debe dejarlo
// intacto. Si alguno lo dañara, los siguientes también fallarían y se vería en la salida.
const h = new QuarantineHarness();
let input: Seeded;
let item: QuarantineItem;
let before: string[];

beforeAll(async () => {
  await h.setup();
  input = await h.seed('original.txt');
  item = await h.manager.quarantine(input.id);
  before = (await fs.readdir(h.root)).sort();
});
afterAll(() => h.close());

/** Rutas absolutas de ataque; todas apuntan dentro de la carpeta de la prueba. */
function attacks(): Array<[string, string]> {
  const r = h.root; // p. ej. C:\Users\...\Temp\cybersoc-adversarial-XXXX
  const noDrive = r.slice(2); // \Users\...
  return [
    ['.. con barra invertida', `${r}\\sub\\..\\fuera.txt`],
    ['.. con barra normal', `${r}/sub/../fuera.txt`],
    ['.. con barras mezcladas', `${r}\\sub/..\\fuera.txt`],
    ['.. al final', `${r}\\sub\\..`],
    ['varios ..', `${r}\\a\\b\\..\\..\\..\\fuera.txt`],
    ['.. en MAYÚSCULAS de ruta', `${r.toUpperCase()}\\SUB\\..\\FUERA.TXT`],
    ['segmento "."', `${r}\\.\\fuera.txt`],
    ['segmento "..." (punto final)', `${r}\\...\\fuera.txt`],
    ['UNC \\\\localhost\\C$', `\\\\localhost\\C$${noDrive}\\unc.txt`],
    [
      'UNC con barras normales',
      `//localhost/C$${noDrive.replaceAll('\\', '/')}/unc.txt`,
    ],
    ['UNC mezclado /\\', `/\\localhost\\C$${noDrive}\\unc.txt`],
    ['prefijo \\\\?\\ (ruta larga)', `\\\\?\\${r}\\larga.txt`],
    ['prefijo \\\\.\\ (dispositivo)', `\\\\.\\${r}\\dispositivo.txt`],
    ['prefijo \\??\\ (NT)', `\\??\\${r}\\nt.txt`],
    ['relativa a la raíz de la unidad', `${noDrive}\\raiz.txt`],
    ['relativa a la unidad (C:x)', `${r.slice(0, 2)}fuera.txt`],
    ['flujo alternativo ADS', `${r}\\ads.txt:oculto`],
    ['flujo ::$DATA', `${r}\\ads.txt::$DATA`],
    ['nombre con punto final', `${r}\\punto.txt.`],
    ['nombre con espacio final', `${r}\\espacio.txt `],
    ['dispositivo NUL', `${r}\\NUL`],
    ['dispositivo con extensión con.txt', `${r}\\con.txt`],
    ['dispositivo COM1 en minúsculas', `${r}\\com1.log`],
    ['carácter nulo', `${r}\\nulo\0.txt`],
    ['comodín *', `${r}\\*.txt`],
    ['comillas', `${r}\\"x".txt`],
  ];
}

describe('restaurar con targetPath hostil: se rechaza y la cuarentena queda intacta', () => {
  it.each(attacks().map(([name]) => [name]))('%s', async (name) => {
    const target = attacks().find(([n]) => n === name)![1];
    h.confirm.mockClear();
    await expect(
      h.manager.restore(item.id, { trustHash: false, targetPath: target }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
    // Se rechaza antes de pedir confirmación y sin escribir nada.
    expect(h.confirm).not.toHaveBeenCalled();
    const record = h.record(item.id);
    expect(record.status).toBe('QUARANTINED');
    expect(record.restoredTo).toBeNull();
    expect(await exists(item.vaultFile)).toBe(true);
    expect((await fs.readdir(h.root)).sort()).toEqual(before);
    expect(h.manager.audit.list(item.id).at(-1)).toMatchObject({
      action: 'RESTORE_FAILED',
    });
  });

  it('rutas relativas (con o sin ..) se rechazan aunque el directorio actual sea válido', async () => {
    const cwd = process.cwd();
    process.chdir(h.root); // si se aceptaran, caerían dentro de la carpeta de la prueba
    try {
      for (const target of [
        'fuera.txt',
        '.\\fuera.txt',
        '..\\fuera.txt',
        'sub/../fuera.txt',
        '',
      ]) {
        await expect(
          h.manager.restore(item.id, { trustHash: false, targetPath: target }),
        ).rejects.toMatchObject({ code: 'INVALID_PATH' });
      }
    } finally {
      process.chdir(cwd);
    }
    expect((await fs.readdir(h.root)).sort()).toEqual(before);
    expect(h.record(item.id).status).toBe('QUARANTINED');
  });

  it('la ruta original manipulada en la BD tampoco permite traversal', async () => {
    const other = await h.seed('otra.txt');
    const second = await h.manager.quarantine(other.id);
    h.tamper(second.id, 'original_path', `${h.root}\\sub\\..\\otra.txt`);
    await expect(
      h.manager.restore(second.id, { trustHash: false }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
    expect(h.record(second.id).status).toBe('QUARANTINED');
    expect(await exists(second.vaultFile)).toBe(true);
  });

  it('después de todos los ataques, una restauración legítima devuelve el mismo SHA-256', async () => {
    const restored = await h.manager.restore(item.id, { trustHash: false });
    expect(restored.status).toBe('RESTORED');
    expect(restored.restoredTo).toBe(input.path);
    expect(sha(await fs.readFile(input.path))).toBe(input.hash);
  });
});

describe('validatePath: nombres reservados de Windows', () => {
  it.each(['CON', 'prn.txt', 'Aux', 'nul.log', 'COM9', 'lpt1.txt'])(
    'rechaza %s (ya cubierto)',
    (name) => {
      expect(() => validatePath(`C:\\carpeta\\${name}`)).toThrow();
    },
  );
  // HALLAZGO T4.3-A: Microsoft (Naming Files, Paths, and Namespaces) reserva también COM0,
  // LPT0 y los superíndices COM¹-COM³ y LPT¹-LPT³. La expresión de paths.ts solo cubre
  // [1-9]. Solo se comprueba la validación: no se crea ningún archivo.
  for (const name of [
    'COM0',
    'LPT0',
    'COM¹',
    'COM²',
    'COM³',
    'LPT¹',
    'LPT²',
    'LPT³',
  ])
    it.fails(`[HALLAZGO A] rechaza ${name} como segmento`, () => {
      expect(() => validatePath(`C:\\carpeta\\${name}.txt`)).toThrow();
    });
});
