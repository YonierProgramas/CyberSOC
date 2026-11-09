import { join } from 'node:path';
import type { EngineCommand } from '../core/engine/EngineProcess';

// Recovered from the Codex T6.2 draft (.worktrees/packaging, base 6d9394d),
// kept without merging; 7.F now accredits the private runtime in the package.

/** Explicit paths: a package looks for Python neither in PATH nor in a machine venv. */
export function resolveEnginePaths(
  appRoot: string,
  packaged: boolean,
  resourcesPath: string,
  platform = process.platform,
): { root: string; cwd: string; command: EngineCommand } {
  const root = packaged
    ? join(resourcesPath, 'engine')
    : join(appRoot, '..', 'engine');
  if (packaged) {
    return {
      root,
      // An .asar is not a valid cwd for a native process.
      cwd: resourcesPath,
      command: {
        file: join(resourcesPath, 'runtime', 'python.exe'),
        // _pth limits imports to package resources; -I ignores PYTHONPATH/HOME.
        args: ['-I', '-B', '-u', '-m', 'cybersoc_engine'],
      },
    };
  }
  return {
    root,
    cwd: appRoot,
    command: {
      file: join(
        root,
        '.venv',
        platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      ),
      // uv sync installs dependencies; the src/ project is not an installed wheel.
      // Passing the path as argv works with spaces without using a shell.
      args: [
        '-B',
        '-u',
        '-c',
        'import sys,runpy;sys.path.insert(0,sys.argv[1]);runpy.run_module("cybersoc_engine",run_name="__main__")',
        join(root, 'src'),
      ],
    },
  };
}
