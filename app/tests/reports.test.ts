import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import {
  ReportBuilder,
  reportFiltersSchema,
} from '../src/core/reports/ReportBuilder';
import { exportHtml } from '../src/core/reports/exporters/html';
import { exportCsv, csvCell } from '../src/core/reports/exporters/csv';
import { exportJson } from '../src/core/reports/exporters/json';
import { ToolRegistry } from '../src/core/ai/tools/ToolRegistry';
import { registerBuildReport } from '../src/core/ai/tools/buildReport';
import { seedReports, hostileName } from './report-fixtures';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { AIAnalysisRepository } from '../src/core/persistence/AIAnalysisRepository';

let root: string, db: Database, builder: ReportBuilder;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cybersoc-reports-'));
  db = new Database(join(root, 'test.db'));
  new MigrationRunner(db).run();
  seedReports(db);
  db.exec('PRAGMA query_only=ON');
  builder = new ReportBuilder(db);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

it('reporte y cada filtro coinciden con SELECT independientes; solo lectura', () => {
  const before = db.prepare('SELECT total_changes() AS n').get();
  for (const [filters, sql, params] of [
    [{}, '1=1', []],
    [{ jobId: 'j1' }, 'job_id=?', ['j1']],
    [{ zone: 'DESCARGAS' }, 'zone=?', ['DESCARGAS']],
    [{ verdicts: ['SUSPICIOUS'] }, 'verdict=?', ['SUSPICIOUS']],
    [
      { from: '2026-10-02', to: '2026-10-03' },
      "scanned_at>='2026-10-02T00:00:00.000Z' AND scanned_at<='2026-10-03T23:59:59.999Z'",
      [],
    ],
    [
      {
        jobId: 'j1',
        zone: 'DESCARGAS',
        verdicts: ['SUSPICIOUS'],
        from: '2026-10-02',
      },
      "job_id='j1' AND zone='DESCARGAS' AND verdict='SUSPICIOUS' AND scanned_at>='2026-10-02T00:00:00.000Z'",
      [],
    ],
  ] as const) {
    const draft = builder.build(reportFiltersSchema.parse(filters));
    const direct = db
      .prepare(
        `SELECT id FROM scan_results WHERE ${sql} ORDER BY job_id,seq,id`,
      )
      .all(...params);
    expect(draft.results.map((row) => row.id)).toEqual(
      direct.map((row) => row.id),
    );
    expect(draft.total).toBe(
      Number(
        db
          .prepare(`SELECT COUNT(*) AS n FROM scan_results WHERE ${sql}`)
          .get(...params)!.n,
      ),
    );
    expect(draft.verdicts).toEqual(
      db
        .prepare(
          `SELECT verdict,COUNT(*) AS files FROM scan_results WHERE ${sql} GROUP BY verdict ORDER BY verdict`,
        )
        .all(...params),
    );
    expect(draft.zones).toEqual(
      db
        .prepare(
          `SELECT zone,COUNT(*) AS files FROM scan_results WHERE ${sql} GROUP BY zone ORDER BY zone`,
        )
        .all(...params),
    );
    expect(draft.evidence).toHaveLength(direct.length);
    expect(draft.layers).toHaveLength(direct.length * 2);
    expect(draft.assessments.every((a) => a.policyVersion === '3')).toBe(true);
    expect(
      draft.jobs.every(
        (job) =>
          job.engineVersion === 'engine-test' &&
          job.rulesetVersion === 'rules-test' &&
          job.signaturesVersion === 'sig-test',
      ),
    ).toBe(true);
  }
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
});

it('fechas normalizadas, límites inclusivos, filtros inválidos y trabajo inexistente', () => {
  expect(
    builder.build({
      from: '2026-10-01T07:00:00-05:00',
      to: '2026-10-01T12:00:00Z',
    }).total,
  ).toBe(1);
  expect(() =>
    builder.build({ from: '2026-11-01', to: '2026-10-01' }),
  ).toThrow();
  expect(() => builder.build({ from: '2026-02-30' })).toThrow();
  expect(() => builder.build({ verdicts: [] })).toThrow();
  expect(() => builder.build({ jobId: "' OR 1=1 --" })).toThrow('NOT_FOUND');
  expect(builder.build({ zone: 'TEMPORALES' }).total).toBe(0);
});

it('borrador estable, copias defensivas, caducidad y expulsión por capacidad', () => {
  let now = 1000;
  const cache = new ReportBuilder(db, {
    now: () => now,
    ttlMs: 10,
    maxDrafts: 2,
  });
  const first = cache.build();
  first.results[0]!.fileName = 'mutado';
  expect(cache.get(first.reportDraftId).results[0]!.fileName).toBe(hostileName);
  const second = cache.build();
  cache.build();
  expect(() => cache.get(first.reportDraftId)).toThrow('NOT_FOUND');
  now += 10;
  expect(() => cache.get(second.reportDraftId)).toThrow('NOT_FOUND');
  const snapshot = builder.build();
  db.exec('PRAGMA query_only=OFF');
  db.prepare('UPDATE scan_results SET file_name=? WHERE id=?').run(
    'posterior',
    'r0',
  );
  expect(builder.get(snapshot.reportDraftId).results[0]!.fileName).toBe(
    hostileName,
  );
});

it('HTML escapado: el nombre <script>alert(1)</script>.exe nunca se interpreta como HTML', () => {
  const draft = builder.build();
  builder.attachNarrative(draft.reportDraftId, {
    executiveSummary: '<svg onload=alert(4)>',
    conclusions: ['<b>conclusión</b> & segura'],
    citedResultIds: ['r0'],
  });
  const html = exportHtml(builder.get(draft.reportDraftId));
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;.exe');
  expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  expect(html).toContain('&lt;svg onload=alert(4)&gt;');
  expect(html).not.toMatch(/<script|<img|<svg|<b>/i);
  expect(html).toContain('Generado por IA');
  expect(html).toContain('default-src');
  expect(html).not.toContain('NOT_EXPORTED');
  expect(draft.total).toBe(4);
  expect(html).not.toContain('9999');
  console.log(
    'HTML_ESCAPE_OK: nombre hostil escapado; evidencias y texto de IA escapados; cifras SQLite=4; sin etiquetas ejecutables.',
  );
});

it('CSV conserva comas, comillas, saltos, Unicode y todas las secciones', () => {
  expect(csvCell('informe, "niño"\r\n😀')).toBe('"informe, ""niño""\r\n😀"');
  const csv = exportCsv(builder.build());
  expect(csv).toContain('"informe, ""niño"".txt"');
  expect(csv).toContain('"evidence"');
  expect(csv).toContain('"layers"');
  expect(csv).toContain('"signaturesVersion","sig-test"');
  expect(csv).toContain('"policyVersion","3"');
  expect(csv).toContain('"label","Generado por IA"');
  expect(csvCell('=SUM(1,2)')).toBe('"\'=SUM(1,2)"');
  expect(csvCell('\t@formula')).toBe('"\'\t@formula"');
  expect(csv.startsWith('\ufeff')).toBe(true);
});

it('JSON conserva el borrador íntegro y la IA no puede reemplazar datos ni inventar citas', () => {
  const draft = builder.build();
  expect(JSON.parse(exportJson(draft))).toEqual(draft);
  expect(() =>
    builder.attachNarrative(draft.reportDraftId, {
      executiveSummary: 'texto',
      conclusions: [],
      citedResultIds: ['inventado'],
    }),
  ).toThrow();
  expect(() =>
    builder.attachNarrative(draft.reportDraftId, {
      executiveSummary: 'texto',
      conclusions: [],
      citedResultIds: [],
      total: 999,
    }),
  ).toThrow();
  expect(builder.get(draft.reportDraftId)).toEqual(draft);
});

it('build_report devuelve ID exportable y el recorte de la herramienta no altera el borrador', async () => {
  db.exec('PRAGMA query_only=OFF');
  const results = new ScanResultRepository(db);
  for (let i = 4; i < 35; i++)
    results.insertComplete({
      result: {
        id: `r${i}`,
        jobId: 'j1',
        seq: i,
        path: `C:\\Fixtures\\${i}.txt`,
        fileName: `${i}.txt`,
        status: 'SCANNED',
        scannedAt: '2026-10-02T12:00:00.000Z',
      },
      evidence: [],
      layers: [],
      assessment: {
        engineVerdict: 'CLEAN',
        engineScore: 0,
        finalVerdict: 'CLEAN',
        finalLevel: 'BAJO',
        reviewRequired: false,
        origin: 'ENGINE',
        traceJson: '[]',
        policyVersion: '3',
        decidedAt: '2026-10-02T12:00:00.000Z',
      },
    });
  db.exec('PRAGMA query_only=ON');
  const registry = new ToolRegistry();
  registerBuildReport(registry, builder);
  const reply = await registry.execute('build_report', {});
  expect(reply.ok).toBe(true);
  if (!reply.ok) throw new Error();
  const info = reply.data as {
    reportDraftId: string;
    total: number;
    results: unknown[];
  };
  expect(reply.truncated).toBe(true);
  expect(info.results.length).toBeLessThanOrEqual(20);
  expect(JSON.stringify(reply).length).toBeLessThanOrEqual(8000);
  expect(builder.get(info.reportDraftId).results).toHaveLength(35);
  expect(builder.get(info.reportDraftId).total).toBe(info.total);
  expect(
    await registry.execute('build_report', { path: 'C:\\no.txt' }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
});

it('conserva únicamente el último análisis válido aunque cambie jobId de null a su trabajo', () => {
  db.exec('PRAGMA query_only=OFF');
  const analyses = new AIAnalysisRepository(db);
  for (const [id, validationStatus, day] of [
    ['ai2', 'VALID', '03'],
    ['ai3', 'SCHEMA_ERROR', '04'],
  ] as const)
    analyses.insert({
      id,
      kind: 'FILE_RESULT',
      resultId: 'r0',
      jobId: 'j1',
      provider: 'fake',
      promptVersion: 'v1',
      contextJson: '{}',
      responseJson: JSON.stringify({ summary: id }),
      validationStatus,
      createdAt: `2026-10-${day}T12:00:00.000Z`,
    });
  db.exec('PRAGMA query_only=ON');
  expect(builder.build().aiSummaries.map((row) => row.id)).toEqual(['ai2']);
});
