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
  // Invariant: each complete prefix has a zone. The trie keeps the last
  // match while walking d segments: O(d), plus O(L characters) normalization.
  // Neither startsWith nor extensions are used: C:\Win does not include C:\Windows.
  private readonly paths = new PathTrie<Zone>();
  // One drive query per root in this session; Map lookup is O(1) average.
  // Creating one classifier per scan avoids keeping stale USB information.
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
    // Removable media takes precedence even if the user moved Downloads to that USB.
    return (await drive).driveType === 'REMOVABLE'
      ? 'EXTRAIBLE'
      : (match ?? 'OTRA');
  }
}
