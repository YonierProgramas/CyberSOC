import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const app = resolve(import.meta.dirname, '../..');
const stage = join(app, 'out/e2e-s11');
mkdirSync(stage, { recursive: true });
const correctionEvidence = resolve(
  app,
  '../../construccion/sprints/sprint-11-distribucion/evidencias/11A-candidato/e2e/correccion-E09-E11',
);
mkdirSync(correctionEvidence, { recursive: true });
writeFileSync(
  join(correctionEvidence, 'bootstrap.cjs'),
  `const {app}=require('electron');app.setAppPath(process.env.S10_APP_ROOT);require(require('node:path').join(process.env.S10_APP_ROOT,'out/instrumentation/main/index.cjs'));`,
);
for (const name of [
  'harness.ts',
  'desktop-ui.e2e.ts',
  'desktop-corrections.e2e.ts',
  'scenarios.e2e.ts',
]) {
  let source = readFileSync(join(app, 'tests/e2e', name), 'utf8');
  source = source
    .replaceAll(
      'sprint-10-escritorio-historial/evidencias/10D-interfaz',
      'sprint-11-distribucion/evidencias/11A-candidato/e2e',
    )
    .replaceAll(
      'sprint-06-robustez-entrega/evidencias/01-e2e-reporte',
      'sprint-11-distribucion/evidencias/11A-candidato/e2e',
    )
    .replaceAll('out/main/index.cjs', 'out/instrumentation/main/index.cjs')
    .replace(
      "resolve(evidence, '../../10B-datos/20-007-sintetico.sqlite')",
      "resolve(appRoot, '../../construccion/sprints/sprint-10-escritorio-historial/evidencias/10B-datos/20-007-sintetico.sqlite')",
    )
    .replace(
      'args: [appRoot]',
      'args: [join(appRoot, "out/instrumentation/bootstrap.cjs")]',
    );
  writeFileSync(join(stage, name), source);
}
writeFileSync(
  join(stage, 'regression.config.ts'),
  `import {defineConfig} from 'playwright/test';export default defineConfig({testDir:'.',testMatch:'*.e2e.ts',timeout:180000,expect:{timeout:20000},workers:1,retries:0,reporter:[['list']],outputDir:${JSON.stringify(resolve(app, '../../construccion/sprints/sprint-11-distribucion/evidencias/11A-candidato/e2e/output'))}});`,
);
console.log(
  'Copias de 28 recorridos de autores S10, solo rutas de build/evidencia adaptadas; timeouts originales.',
);
