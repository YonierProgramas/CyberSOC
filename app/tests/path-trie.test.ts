import { describe, expect, it } from 'vitest';
import { PathTrie } from '../src/core/structures/PathTrie';

describe('PathTrie: zonas por segmentos Windows', () => {
  it('vacío: no hay coincidencia ni prefijos', () => {
    const trie = new PathTrie<string>();
    expect(trie.size).toBe(0);
    expect(trie.longestPrefixMatch('C:\\archivo.txt')).toBeUndefined();
  });

  it.each([false, true])(
    'Temp prevalece sobre LocalAppData, independientemente del orden (%s)',
    (reverse) => {
      const trie = new PathTrie<string>();
      const entries = [
        ['C:\\Users\\Ana\\AppData\\Local', 'DATOS_APPS'],
        ['C:\\Users\\Ana\\AppData\\Local\\Temp', 'TEMPORALES'],
      ] as const;
      for (const [prefix, zone] of reverse ? [...entries].reverse() : entries) {
        trie.insert(prefix, zone);
      }
      expect(
        trie.longestPrefixMatch('C:\\Users\\Ana\\AppData\\Local\\Temp\\x.exe'),
      ).toBe('TEMPORALES');
      expect(
        trie.longestPrefixMatch(
          'C:\\Users\\Ana\\AppData\\Local\\Editor\\x.txt',
        ),
      ).toBe('DATOS_APPS');
      expect(trie.size).toBe(2);
    },
  );

  it.each([
    'c:/users/ana/DOWNLOADS/factura.pdf',
    'C:\\USERS\\ANA\\Downloads\\factura.pdf',
    'c:/USERS\\Ana/Downloads\\\\factura.pdf',
    'C:\\Users\\Ana\\Downloads',
    'c:/users/ana/downloads/',
  ])('normaliza mayúsculas, unidad y separadores: %s', (path) => {
    const trie = new PathTrie<string>();
    trie.insert('C:\\Users\\Ana\\Downloads\\', 'DESCARGAS');
    expect(trie.longestPrefixMatch(path)).toBe('DESCARGAS');
  });

  it('conserva ñ y tildes al comparar sin distinguir mayúsculas', () => {
    const trie = new PathTrie<string>();
    trie.insert('C:\\Usuarios\\NIÑA\\Documentación', 'DOCUMENTOS');
    expect(
      trie.longestPrefixMatch('c:/usuarios/niña/documentación/año.txt'),
    ).toBe('DOCUMENTOS');
  });

  it('no confunde prefijos parciales ni carpetas con nombres parecidos', () => {
    const trie = new PathTrie<string>();
    trie.insert('C:\\Win', 'CORTO');
    expect(trie.longestPrefixMatch('C:\\Windows\\x.dll')).toBeUndefined();
    expect(trie.longestPrefixMatch('C:\\Win.old\\x.dll')).toBeUndefined();
    expect(trie.longestPrefixMatch('C:\\Win\\x.dll')).toBe('CORTO');
  });

  it('no devuelve nodos intermedios que no tienen un prefijo registrado', () => {
    const trie = new PathTrie<string>();
    trie.insert('C:\\A\\B\\C', 'PROFUNDO');
    expect(trie.longestPrefixMatch('C:\\A\\B')).toBeUndefined();
    expect(trie.longestPrefixMatch('C:\\Otra\\x')).toBeUndefined();
    expect(trie.size).toBe(1);
  });

  it('recuerda el último ancestro con valor al fallar una rama intermedia', () => {
    const trie = new PathTrie<string>();
    trie.insert('C:\\A', 'PADRE');
    trie.insert('C:\\A\\B\\C', 'HIJO');
    expect(trie.longestPrefixMatch('C:\\A\\B\\D\\x')).toBe('PADRE');
  });

  it('aísla unidades y permite clasificar la raíz y cualquier descendiente', () => {
    const trie = new PathTrie<string>();
    trie.insert('C:/', 'UNIDAD_C');
    trie.insert('C:\\Windows', 'SISTEMA');
    trie.insert('D:\\', 'UNIDAD_D');
    expect(trie.longestPrefixMatch('c:\\')).toBe('UNIDAD_C');
    expect(trie.longestPrefixMatch('C:\\Otro\\x')).toBe('UNIDAD_C');
    expect(trie.longestPrefixMatch('c:/windows/x')).toBe('SISTEMA');
    expect(trie.longestPrefixMatch('D:\\Windows\\x')).toBe('UNIDAD_D');
    expect(trie.longestPrefixMatch('E:\\Windows\\x')).toBeUndefined();
  });

  it('actualiza un prefijo equivalente sin aumentar size', () => {
    const trie = new PathTrie<{ id: number }>();
    trie.insert('C:\\DATOS\\', { id: 1 });
    const replacement = { id: 2 };
    trie.insert('c:/datos', replacement);
    expect(trie.size).toBe(1);
    expect(trie.longestPrefixMatch('C:\\Datos\\x')).toBe(replacement);
  });

  it('acepta valores falsy y undefined sin confundirlos con nodos vacíos', () => {
    const trie = new PathTrie<number | boolean | null | undefined>();
    trie.insert('C:\\', 9);
    trie.insert('C:\\Cero', 0);
    trie.insert('C:\\Falso', false);
    trie.insert('C:\\Nulo', null);
    trie.insert('C:\\Vacio', undefined);
    trie.insert('c:/vacio/', undefined);
    expect(trie.size).toBe(5);
    expect(trie.longestPrefixMatch('C:\\Cero\\x')).toBe(0);
    expect(trie.longestPrefixMatch('C:\\Falso\\x')).toBe(false);
    expect(trie.longestPrefixMatch('C:\\Nulo\\x')).toBeNull();
    expect(trie.longestPrefixMatch('C:\\Vacio\\x')).toBeUndefined();
  });

  it('normaliza segmentos punto y punto-punto sin clasificar fuera de la zona', () => {
    const trie = new PathTrie<string>();
    trie.insert('C:\\Datos\\.\\Temp\\', 'TEMP');
    expect(trie.longestPrefixMatch('C:\\Datos\\Otro\\..\\Temp\\x')).toBe(
      'TEMP',
    );
    expect(trie.longestPrefixMatch('C:\\Datos\\Temp\\..\\x')).toBeUndefined();
  });

  it('aísla recursos UNC y admite su raíz como prefijo', () => {
    const trie = new PathTrie<string>();
    trie.insert('\\\\SERVIDOR\\Compartido', 'RED');
    trie.insert('//servidor/compartido/Temp', 'TEMP_RED');
    expect(trie.longestPrefixMatch('\\\\servidor\\compartido\\')).toBe('RED');
    expect(trie.longestPrefixMatch('//SERVIDOR/Compartido/Temp/x')).toBe(
      'TEMP_RED',
    );
    expect(trie.longestPrefixMatch('\\\\servidor\\otro\\x')).toBeUndefined();
    expect(trie.longestPrefixMatch('\\\\otro\\compartido\\x')).toBeUndefined();
  });

  it.each([
    '',
    'relativa\\x',
    'C:Temp',
    '\\Windows',
    '\\\\servidor',
    '\\\\?\\C:\\Temp',
    '\\\\.\\C:\\Temp',
    'C:\\a\0b',
  ])(
    'rechaza rutas ambiguas o de dispositivos sin modificar el trie: %j',
    (path) => {
      const trie = new PathTrie<string>();
      expect(() => trie.insert(path, 'INVALIDA')).toThrow(TypeError);
      expect(() => trie.longestPrefixMatch(path)).toThrow(TypeError);
      expect(trie.size).toBe(0);
    },
  );
});
