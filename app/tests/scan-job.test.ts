import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('ScanJob: case table and native coverage of lines, branches and functions ≥ 90 %', () => {
  // Node's built-in coverage avoids an additional coverage provider dependency.
  const output = execFileSync(
    process.execPath,
    [
      '--experimental-test-coverage',
      '--test-coverage-include=**/src/core/domain/ScanJob.ts',
      '--test-coverage-lines=90',
      '--test-coverage-branches=90',
      '--test-coverage-functions=90',
      '--test-reporter=tap',
      '--test',
      'tests/scan-job.cases.mjs',
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    },
  );
  // Guard against an empty report passing the thresholds vacuously.
  expect(output).toContain('ScanJob.ts');
  expect(output).toContain('# fail 0');
}, 25_000);
