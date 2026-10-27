import { join } from 'node:path';
import type { EngineCommand } from '../core/engine/EngineProcess';

// Recuperado del borrador Codex T6.2 (.worktrees/packaging, base 6d9394d),
// conservado sin merge; 7.F acredita ahora el runtime privado en el paquete.

/** Rutas explícitas: un paquete no busca Python en PATH ni en un venv del equipo. */
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
      // Un .asar no es un directorio válido para cwd de un proceso nativo.
      cwd: resourcesPath,
      command: {
        file: join(resourcesPath, 'runtime', 'python.exe'),
        // _pth limita imports a recursos del paquete; -I ignora PYTHONPATH/HOME.
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
      // uv sync instala dependencias; el proyecto src/ no es un wheel instalado.
      // Pasar la ruta como argv funciona con espacios sin usar un shell.
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
