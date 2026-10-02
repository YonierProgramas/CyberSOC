import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { decideRisk } from '../src/core/risk/RiskPolicy';
import { engineResultSchema } from '../src/shared/protocol';
import { ReportBuilder } from '../src/core/reports/ReportBuilder';
import { serializeReport } from '../src/core/reports/exporters';

const engine = resolve('../engine');
const python = join(
  engine,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
it.skipIf(!existsSync(python))(
  'ejemplo de reporte: fixtures benignos del generador, motor real y tres formatos',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'cybersoc-report-example-'));
    const db = new Database(join(root, 'example.db'));
    try {
      const startedAt = new Date().toISOString();
      const scanned = JSON.parse(
        execFileSync(
          python,
          [
            '-c',
            `
import json, runpy
from cybersoc_engine.analysis.file_inspector import FileInspector
from cybersoc_engine.models import ScanFileOptions
from cybersoc_engine.engines.signature_engine import SignatureCatalog
from cybersoc_engine.engines.rule_engine import default_rules
generate = runpy.run_path('tests/fixtures/generate.py')['generate_fixtures']
inspector = FileInspector()
with generate(include_filetype=True, include_signatures=True, include_rules=True, include_heuristics=True) as root:
    rows = []
    for index, path in enumerate(sorted(p for p in root.rglob('*') if p.is_file())):
        result = inspector.inspect(str(path), ScanFileOptions(maxBytes=1048576, zone='DESCARGAS'), task_id=str(index))
        rows.append({'path': str(path), 'result': result.model_dump(mode='json', exclude_unset=True)})
    print(json.dumps({'root':str(root), 'rows':rows, 'signaturesVersion':SignatureCatalog().version, 'rulesetVersion':default_rules.current().version}))
`,
          ],
          {
            cwd: engine,
            encoding: 'utf8',
            timeout: 60000,
            maxBuffer: 5 * 1024 * 1024,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              TEMP: process.env.TEMP,
              TMP: process.env.TMP,
              PYTHONPATH: join(engine, 'src'),
              PYTHONUTF8: '1',
            },
          },
        ),
      ) as {
        root: string;
        rows: { path: string; result: unknown }[];
        signaturesVersion: string;
        rulesetVersion: string;
      };
      new MigrationRunner(db).run();
      const jobs = new ScanJobRepository(db),
        results = new ScanResultRepository(db);
      const stamp = new Date().toISOString();
      const first = engineResultSchema.parse(scanned.rows[0]!.result);
      jobs.create({
        id: 'report-fixtures',
        targetPath: scanned.root,
        targetKind: 'FOLDER',
        engineVersion: first.engineVersion,
        signaturesVersion: scanned.signaturesVersion,
        rulesetVersion: scanned.rulesetVersion,
        createdAt: startedAt,
      });
      for (const [seq, row] of scanned.rows.entries()) {
        const result = engineResultSchema.parse(row.result);
        const decision =
          result.status === 'SCANNED' && result.score != null
            ? decideRisk({
                verdict: result.verdict as 'CLEAN' | 'SUSPICIOUS' | 'DETECTED',
                score: result.score,
              })
            : null;
        results.insertComplete({
          result: {
            id: `fixture-${seq}`,
            jobId: 'report-fixtures',
            seq,
            path: row.path,
            fileName: result.file!.name,
            status: result.status,
            sha256: result.hashes?.sha256 ?? null,
            sizeBytes: result.file!.sizeBytes,
            zone: 'DESCARGAS',
            scannedAt: stamp,
          },
          evidence: result.evidence,
          layers: result.layers,
          assessment: decision
            ? {
                engineVerdict: decision.engineVerdict,
                engineScore: decision.engineScore,
                finalVerdict: decision.finalVerdict,
                finalLevel: decision.finalLevel,
                reviewRequired: decision.reviewRequired,
                origin: decision.origin,
                traceJson: JSON.stringify(decision.trace),
                policyVersion: decision.policyVersion,
                decidedAt: stamp,
              }
            : null,
        });
      }
      jobs.updateStatus('report-fixtures', 'COMPLETED', {
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      const counters = db
        .prepare(
          `SELECT COUNT(*) AS filesProcessed,
        SUM(status='ERROR') AS filesError,SUM(status='SKIPPED') AS filesSkipped,
        SUM(COALESCE(size_bytes,0)) AS bytesProcessed FROM scan_results`,
        )
        .get()!;
      jobs.updateCounters('report-fixtures', {
        filesDiscovered: scanned.rows.length,
        filesProcessed: Number(counters.filesProcessed),
        filesError: Number(counters.filesError),
        filesSkipped: Number(counters.filesSkipped),
        bytesProcessed: Number(counters.bytesProcessed),
      });
      const draft = new ReportBuilder(db).build({ jobId: 'report-fixtures' });
      expect(draft.total).toBe(scanned.rows.length);
      expect(draft.verdicts).toContainEqual(
        expect.objectContaining({ verdict: 'DETECTED' }),
      );
      const destination = process.env.CYBERSOC_REPORT_EVIDENCE_DIR ?? root;
      for (const format of ['html', 'csv', 'json'] as const) {
        const path = join(destination, `07-reporte-exportado.${format}`);
        writeFileSync(path, serializeReport(draft, format), 'utf8');
        expect(readFileSync(path, 'utf8').length).toBeGreaterThan(100);
      }
      console.log(
        'REPORT_FIXTURES',
        JSON.stringify({
          files: draft.total,
          verdicts: draft.verdicts,
          engineVersion: first.engineVersion,
          policyVersion: '3',
          realApiCalls: 0,
        }),
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  65000,
);
