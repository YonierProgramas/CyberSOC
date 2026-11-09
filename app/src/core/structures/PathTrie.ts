import { win32 } from 'node:path';

interface TrieNode<T> {
  children: Map<string, TrieNode<T>>;
  // The wrapper distinguishes "no value" from a T whose value is undefined.
  entry: { value: T } | undefined;
}

function createNode<T>(): TrieNode<T> {
  return { children: new Map(), entry: undefined };
}

function segments(path: string): string[] {
  const windowsPath = path.replaceAll('/', '\\');
  // Relative paths are not resolved against the current process directory.
  // Device namespaces are not ordinary zone paths.
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
  // O(L) in time and space, L being characters. win32 also works on Linux.
  const normalized = win32.normalize(windowsPath).toLowerCase();
  const root = win32.parse(normalized).root;
  return [root, ...normalized.slice(root.length).split('\\').filter(Boolean)];
}

/**
 * Invariant: each edge represents a complete normalized segment; the drive
 * or UNC share root is the first segment. Only inserted prefixes
 * have an entry. Thus C:\Win never partially matches C:\Windows.
 * Children use a Map: O(1) average access, without walking sibling prefixes.
 */
export class PathTrie<T> {
  private readonly root = createNode<T>();
  private count = 0;

  /** O(1): number of distinct prefixes, not of intermediate nodes. */
  get size(): number {
    return this.count;
  }

  /**
   * O(d) average steps for d segments, plus O(L) for normalization/hashing.
   * Creates at most d nodes; total memory depends on shared segments.
   * Inserting an equivalent prefix replaces its value without incrementing size.
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
   * O(d) average steps plus O(L) to normalize and process the strings.
   * Keeps the last entry found: if a branch ends, the most specific
   * ancestor wins, not necessarily the last visited node.
   * It is a lexical comparison: it does not consult the disk, links or permissions.
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
