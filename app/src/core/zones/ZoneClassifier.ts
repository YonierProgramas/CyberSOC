import { win32 } from 'node:path';
import {
  driveInfoResultSchema,
  type DriveInfoResult,
  type Zone,
} from '../../shared/protocol';
import { PathTrie } from '../structures/PathTrie';

export interface ZoneRoot {
  path: string;
  zone: Exclude<Zone, 'OTRA' | 'EXTRAIBLE'>;
}

export class ZoneClassifier {
  // Invariante: cada prefijo completo tiene una zona. El trie conserva la última
  // coincidencia al recorrer d segmentos: O(d), más normalización O(L caracteres).
  // No se usan startsWith ni extensiones: C:\Win no incluye C:\Windows.
  private readonly paths = new PathTrie<Zone>();
  // Una consulta de unidad por raíz en esta sesión; Map busca en O(1) promedio.
  // Crear un clasificador por escaneo evita conservar información vieja de USB.
  private readonly drives = new Map<string, Promise<DriveInfoResult>>();

  constructor(
    roots: readonly ZoneRoot[],
    private readonly driveInfo: (path: string) => Promise<DriveInfoResult>,
  ) {
    for (const root of roots) this.paths.insert(root.path, root.zone);
  }

  async classify(path: string): Promise<Zone> {
    const match = this.paths.longestPrefixMatch(path);
    const root = win32
      .parse(win32.normalize(path.replaceAll('/', '\\')))
      .root.toLowerCase();
    let drive = this.drives.get(root);
    if (!drive) {
      drive = this.driveInfo(root).then((value) =>
        driveInfoResultSchema.parse(value),
      );
      this.drives.set(root, drive);
      void drive.catch(() => this.drives.delete(root));
    }
    // El medio extraíble prima incluso si el usuario trasladó Descargas a esa USB.
    return (await drive).driveType === 'REMOVABLE'
      ? 'EXTRAIBLE'
      : (match ?? 'OTRA');
  }
}
