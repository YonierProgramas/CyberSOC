import { win32 } from 'node:path';

interface TrieNode<T> {
  children: Map<string, TrieNode<T>>;
  // El contenedor distingue "sin valor" de un T cuyo valor sea undefined.
  entry: { value: T } | undefined;
}

function createNode<T>(): TrieNode<T> {
  return { children: new Map(), entry: undefined };
}

function segments(path: string): string[] {
  const windowsPath = path.replaceAll('/', '\\');
  // No se resuelven rutas relativas contra el directorio actual del proceso.
  // Los espacios de nombres de dispositivos no son rutas de zonas ordinarias.
  if (
    windowsPath.includes('\0') ||
    windowsPath.startsWith('\\\\?\\') ||
    windowsPath.startsWith('\\\\.\\') ||
    !/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/i.test(windowsPath)
  ) {
    throw new TypeError(
      'Se requiere una ruta Windows absoluta de unidad o UNC.',
    );
  }
  // O(L) en tiempo y espacio, con L caracteres. win32 funciona también en Linux.
  const normalized = win32.normalize(windowsPath).toLowerCase();
  const root = win32.parse(normalized).root;
  return [root, ...normalized.slice(root.length).split('\\').filter(Boolean)];
}

/**
 * Invariante: cada arista representa un segmento completo normalizado; la raíz
 * de unidad o recurso UNC es el primer segmento. Solo los prefijos insertados
 * tienen entry. Así, C:\Win nunca coincide parcialmente con C:\Windows.
 * Los hijos usan Map: acceso O(1) promedio, sin recorrer los prefijos hermanos.
 */
export class PathTrie<T> {
  private readonly root = createNode<T>();
  private count = 0;

  /** O(1): número de prefijos distintos, no número de nodos intermedios. */
  get size(): number {
    return this.count;
  }

  /**
   * O(d) pasos promedio para d segmentos, más O(L) de normalización/hashing.
   * Crea como máximo d nodos; la memoria total depende de segmentos compartidos.
   * Insertar un prefijo equivalente sustituye su valor, sin incrementar size.
   */
  insert(prefix: string, value: T): void {
    let node = this.root;
    for (const segment of segments(prefix)) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = createNode<T>();
        node.children.set(segment, child);
      }
      node = child;
    }
    if (node.entry === undefined) this.count += 1;
    node.entry = { value };
  }

  /**
   * O(d) pasos promedio más O(L) para normalizar y procesar las cadenas.
   * Conserva la última entrada encontrada: si una rama termina, gana el
   * ancestro más específico, no necesariamente el último nodo visitado.
   * Es una comparación léxica: no consulta disco, enlaces ni permisos.
   */
  longestPrefixMatch(path: string): T | undefined {
    let node = this.root;
    let match: T | undefined;
    for (const segment of segments(path)) {
      const child = node.children.get(segment);
      if (child === undefined) break;
      node = child;
      if (node.entry !== undefined) match = node.entry.value;
    }
    return match;
  }
}
