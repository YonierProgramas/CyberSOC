import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Regresión B-01/AUD-12: collect-notices.py debe copiar las licencias de cada wheel.
// Usa el Python 3.12 del motor (misma versión que el runtime empaquetado) y un
// site-packages ficticio en TEMP. El modo --list-wheel-licenses no descarga ni escribe.
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'collect-notices.py');
const python = join(
  here,
  '../../../engine/.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

test(
  'avisos: encuentra LICENSE de cada dist-info, también dentro de licenses/',
  { skip: !existsSync(python) && 'falta engine/.venv (uv sync --locked)' },
  () => {
    const site = mkdtempSync(join(tmpdir(), 'cybersoc-avisos-'));
    try {
      const plain = join(site, 'demo-1.0.dist-info');
      const nested = join(site, 'otra-2.0.dist-info', 'licenses');
      mkdirSync(plain, { recursive: true });
      mkdirSync(nested, { recursive: true });
      mkdirSync(join(site, 'demo'), { recursive: true });
      writeFileSync(join(plain, 'LICENSE'), 'MIT de ejemplo');
      writeFileSync(join(plain, 'METADATA'), 'no es licencia');
      writeFileSync(join(nested, 'LICENSE.txt'), 'Apache de ejemplo');
      writeFileSync(join(nested, 'NOTICE'), 'aviso de ejemplo');
      writeFileSync(join(site, 'demo', 'LICENSE'), 'fuera de dist-info');
      const listed = JSON.parse(
        execFileSync(
          python,
          ['-I', '-B', script, '--list-wheel-licenses', site],
          {
            encoding: 'utf8',
          },
        ),
      );
      assert.deepEqual(listed, [
        ['demo-1.0.dist-info', 'LICENSE'],
        ['otra-2.0.dist-info', 'licenses/LICENSE.txt'],
        ['otra-2.0.dist-info', 'licenses/NOTICE'],
      ]);
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  },
);
