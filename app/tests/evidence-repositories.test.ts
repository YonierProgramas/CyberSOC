import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Evidence, LayerTrace } from '../src/shared/protocol';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { initialMigration } from '../src/core/persistence/migrations/001_init';
import { scansMigration } from '../src/core/persistence/migrations/002_scans';
import { evidenceAiMigration } from '../src/core/persistence/migrations/003_evidence_ai';
import { EvidenceRepository } from '../src/core/persistence/EvidenceRepository';
import { LayerTraceRepository } from '../src/core/persistence/LayerTraceRepository';
import { RiskAssessmentRepository } from '../src/core/persistence/RiskAssessmentRepository';
import {
  AIAnalysisRepository,
  type InsertAIAnalysis,
} from '../src/core/persistence/AIAnalysisRepository';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import {
  ScanResultRepository,
  type InsertCompleteResult,
  type InsertScanResult,
} from '../src/core/persistence/ScanResultRepository';

const date = '2026-09-30T12:00:00.000Z';
const evidence: Evidence = {
  id: 'ev1',
  source: 'SIGNATURES',
  code: 'SIGNATURE_MATCH',
  title: "Firma ñ 😀 '; DROP TABLE evidences; --",
  severity: 'CRITICAL',
  points: 40,
  decisive: true,
  confidence: 1,
  facts: { signatureId: 'CSD-TEST-001', nested: { values: [false, null, 3] } },
};
const layers: LayerTrace[] = [
  { layer: 'HASH', status: 'RAN', hits: 0, points: 0, ms: 1.25 },
  { layer: 'SIGNATURES', status: 'RAN', hits: 1, points: 40, ms: 0.25 },
  {
    layer: 'FILETYPE',
    status: 'SKIPPED',
    reason: 'TEST_ONLY',
    hits: 0,
    points: 0,
    ms: 0,
  },
];

function result(seq = 0, jobId = 'job'): InsertScanResult {
  return {
    id: `${jobId}-${seq}`,
    jobId,
    seq,
    path: `C:\\niño\\${seq}.txt`,
    fileName: `${seq}.txt`,
    status: 'SCANNED',
    scannedAt: date,
  };
}
function complete(seq = 0, jobId = 'job'): InsertCompleteResult {
  return {
    result: {
      ...result(seq, jobId),
      aiStatus: 'PENDING',
      detectedType: 'texto',
    },
    evidence: [evidence],
    layers,
    assessment: {
      engineVerdict: 'DETECTED',
      engineScore: 85,
      finalVerdict: 'DETECTED',
      finalLevel: 'CRÍTICO',
      reviewRequired: false,
      origin: 'ENGINE',
      traceJson: '{"rule":"decisive","evidenceIds":["ev1"]}',
      policyVersion: 'v1',
      decidedAt: date,
    },
  };
}
function analysis(id = 'analysis', resultId = 'job-0'): InsertAIAnalysis {
  return {
    id,
    kind: 'FILE_RESULT',
    resultId,
    provider: 'fake',
    model: 'test',
    promptVersion: 'v1',
    contextJson: '{ "name": "niño 😀" }',
    responseJson: '{"summary":"prueba"}',
    validationStatus: 'VALID',
    createdAt: date,
  };
}

describe('Migración 003 y repositorios de evidencia en una BD temporal', () => {
  let directory: string;
  let db: Database;
  let results: ScanResultRepository;
  let evidences: EvidenceRepository;
  let traces: LayerTraceRepository;
  let risks: RiskAssessmentRepository;
  let ai: AIAnalysisRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cybersoc-evidence-repos-'));
    db = new Database(join(directory, 'evidencia.db'));
    new MigrationRunner(db).run();
    bindRepositories();
    for (const id of ['job', 'other'])
      new ScanJobRepository(db).create({
        id,
        targetPath: 'C:\\niño',
        targetKind: 'FOLDER',
      });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    // Solo se elimina la carpeta temporal creada por esta prueba.
    rmSync(directory, { recursive: true, force: true });
  });
  function bindRepositories() {
    results = new ScanResultRepository(db);
    evidences = new EvidenceRepository(db);
    traces = new LayerTraceRepository(db);
    risks = new RiskAssessmentRepository(db);
    ai = new AIAnalysisRepository(db);
  }
  function count(table: string) {
    // table proviene exclusivamente de literales de estas pruebas.
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
  }

  it('migra v2 con datos, conserva valores y aplica 003 una sola vez al reabrir', () => {
    const old = new Database(join(directory, 'v2.db'));
    try {
      new MigrationRunner(old, [initialMigration, scansMigration]).run();
      // Datos v2 mediante SQL histórico: el repositorio actual requiere 004.
      old
        .prepare(
          `INSERT INTO scan_jobs (id, target_path, target_kind, status, created_at)
        VALUES ('legacy', ?, 'FILE', 'CREATED', ?)`,
        )
        .run('C:\\á', date);
      old
        .prepare(
          `INSERT INTO scan_results (id, job_id, seq, path, file_name, status, scanned_at)
        VALUES ('legacy', 'legacy', 0, 'C:\\á', 'á', 'ERROR', ?)`,
        )
        .run(date);
      const before = old.prepare('SELECT * FROM scan_results').get();
      const v3 = new MigrationRunner(old, [
        initialMigration,
        scansMigration,
        evidenceAiMigration,
      ]);
      expect(v3.run()).toEqual([3]);
      expect(old.prepare('SELECT * FROM scan_results').get()).toEqual({
        ...before,
        detected_type: null,
        engine_score: null,
        risk_level: null,
        ai_status: 'NOT_REQUIRED',
      });
      expect(v3.run()).toEqual([]);
      expect(new MigrationRunner(old).run()).toEqual([4]);
    } finally {
      old.close();
    }
    const reopened = new Database(join(directory, 'v2.db'));
    try {
      expect(new MigrationRunner(reopened).run()).toEqual([]);
      expect(new ScanResultRepository(reopened).get('legacy')).toMatchObject({
        status: 'ERROR',
        verdict: 'NOT_EVALUATED',
      });
    } finally {
      reopened.close();
    }
  });

  it('crea las cuatro tablas, columnas e índices y respeta NOT NULL y CHECK del plan', () => {
    const columns = (table: string) =>
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
    expect(columns('evidences')).toEqual([
      'id',
      'result_id',
      'evidence_key',
      'source',
      'code',
      'title',
      'severity',
      'points',
      'decisive',
      'confidence',
      'details_json',
    ]);
    expect(columns('risk_assessments')).toEqual([
      'result_id',
      'engine_verdict',
      'engine_score',
      'ai_opinion',
      'ai_confidence',
      'final_verdict',
      'final_level',
      'review_required',
      'origin',
      'trace_json',
      'policy_version',
      'decided_at',
    ]);
    expect(columns('ai_analyses')).toEqual([
      'id',
      'kind',
      'result_id',
      'job_id',
      'provider',
      'model',
      'prompt_version',
      'context_json',
      'context_sha256',
      'response_json',
      'validation_status',
      'error_kind',
      'input_tokens',
      'output_tokens',
      'latency_ms',
      'created_at',
    ]);
    expect(columns('result_layers')).toEqual([
      'result_id',
      'layer',
      'status',
      'reason',
      'hits',
      'points',
      'duration_ms',
    ]);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_results_score',
        'idx_ai_result',
        'idx_layers_layer',
      ]),
    );
    results.insertComplete(complete());
    expect(() =>
      db.exec('UPDATE risk_assessments SET engine_score = NULL'),
    ).toThrow('NOT NULL');
    expect(() =>
      db.exec('UPDATE risk_assessments SET final_level = NULL'),
    ).toThrow('NOT NULL');
    expect(() => db.exec("UPDATE result_layers SET status = 'BAD'")).toThrow(
      'CHECK',
    );
  });

  it('revierte también los ALTER TABLE si 003 falla a mitad de la migración', () => {
    const old = new Database(join(directory, 'conflict.db'));
    try {
      new MigrationRunner(old, [initialMigration, scansMigration]).run();
      old.exec('CREATE TABLE evidences (legacy TEXT)');
      expect(() => new MigrationRunner(old).run()).toThrow('already exists');
      expect(
        old
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
      expect(
        old
          .prepare('PRAGMA table_info(scan_results)')
          .all()
          .some((r) => r.name === 'engine_score'),
      ).toBe(false);
      expect(
        old
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'idx_results_score'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      old.close();
    }
  });

  it('persiste el resultado completo y sus detalles Unicode tras cerrar y reabrir', () => {
    const calls = vi.spyOn(db, 'exec');
    const saved = results.insertComplete(complete());
    expect(
      calls.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE'),
    ).toHaveLength(1);
    expect(calls.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(
      1,
    );
    expect(saved).toMatchObject({
      engineScore: 85,
      riskLevel: 'CRÍTICO',
      aiStatus: 'PENDING',
      detectedType: 'texto',
      verdict: 'DETECTED',
    });
    const facts = evidences.listByResult(saved.id);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      resultId: saved.id,
      evidenceKey: 'ev1',
      decisive: true,
      title: evidence.title,
    });
    expect(facts[0]!.id).not.toBe('ev1');
    expect(JSON.parse(facts[0]!.detailsJson)).toEqual(evidence.facts);
    expect(traces.listByResult(saved.id)).toEqual(
      layers.map((l) => ({
        ...l,
        resultId: saved.id,
        reason: l.reason ?? null,
      })),
    );
    expect(risks.get(saved.id)).toEqual({
      ...complete().assessment,
      resultId: saved.id,
      aiOpinion: null,
      aiConfidence: null,
    });
    db.close();
    db = new Database(db.path);
    bindRepositories();
    expect(results.get(saved.id)).toEqual(saved);
    expect(evidences.listByResult(saved.id)).toEqual(facts);
    expect(risks.get(saved.id)?.reviewRequired).toBe(false);
  });

  it.each(['scan_results', 'evidences', 'result_layers', 'risk_assessments'])(
    'revierte todo cuando un trigger falla después de insertar en %s',
    (table) => {
      results.insertComplete(complete(0, 'other'));
      db.exec(
        `CREATE TRIGGER forced_failure AFTER INSERT ON ${table} BEGIN SELECT RAISE(FAIL, 'forced failure'); END;`,
      );
      expect(() => results.insertComplete(complete())).toThrow(
        'forced failure',
      );
      expect(results.get('job-0')).toBeUndefined();
      expect(evidences.listByResult('job-0')).toEqual([]);
      expect(traces.listByResult('job-0')).toEqual([]);
      expect(risks.get('job-0')).toBeUndefined();
      expect(results.get('other-0')).toBeDefined();
      db.exec('DROP TRIGGER forced_failure');
      expect(results.insertComplete(complete()).id).toBe('job-0');
    },
  );

  it('no publica escrituras de repositorios internos antes del COMMIT exterior', () => {
    const observer = new Database(db.path);
    try {
      db.transaction(() => {
        results.insertComplete(complete());
        expect(observer.prepare('SELECT * FROM scan_results').all()).toEqual(
          [],
        );
      });
      expect(observer.prepare('SELECT * FROM scan_results').all()).toHaveLength(
        1,
      );
      expect(() =>
        db.transaction(() => {
          results.insertComplete(complete(1));
          throw new Error('outer failure');
        }),
      ).toThrow('outer failure');
      expect(results.get('job-1')).toBeUndefined();
    } finally {
      observer.close();
    }
  });

  it('un savepoint fallido no borra trabajo previo si el llamador captura el error', () => {
    db.transaction(() => {
      results.insertResult(result());
      expect(() => evidences.insertMany('job-0', [evidence, evidence])).toThrow(
        'UNIQUE',
      );
      expect(evidences.listByResult('job-0')).toEqual([]);
      results.insertResult(result(1));
    });
    expect(results.listByJob('job', 0, 10)).toHaveLength(2);
  });

  it('separa UUID global y evN local, ordena ev2 antes de ev10 y rechaza duplicados', () => {
    results.insertResult(result());
    results.insertResult(result(1));
    evidences.insertMany(
      'job-0',
      ['ev10', 'ev2', 'ev1'].map((id) => ({ ...evidence, id })),
    );
    evidences.insertMany('job-1', [evidence]);
    expect(evidences.listByResult('job-0').map((e) => e.evidenceKey)).toEqual([
      'ev1',
      'ev2',
      'ev10',
    ]);
    expect(evidences.listByResult('job-0')[0]!.id).not.toBe(
      evidences.listByResult('job-1')[0]!.id,
    );
    expect(() => evidences.insertMany('job-0', [evidence])).toThrow('UNIQUE');
    expect(() => evidences.insertMany('missing', [evidence])).toThrow(
      'FOREIGN KEY',
    );
  });

  it('revierte lotes con capa duplicada o motivo SKIPPED ausente', () => {
    results.insertResult(result());
    expect(() => traces.insertTrace('job-0', [layers[0]!, layers[0]!])).toThrow(
      'UNIQUE',
    );
    expect(traces.listByResult('job-0')).toEqual([]);
    expect(() =>
      traces.insertTrace('job-0', [
        layers[0]!,
        { ...layers[1]!, status: 'SKIPPED' },
      ]),
    ).toThrow();
    expect(traces.listByResult('job-0')).toEqual([]);
    expect(() => traces.insertTrace('missing', layers)).toThrow('FOREIGN KEY');
  });

  it('agrega archivos, estados, hallazgos, puntos y tiempo solo del trabajo indicado', () => {
    for (const [seq, status] of (
      ['RAN', 'SKIPPED', 'DISABLED', 'ERROR'] as const
    ).entries()) {
      results.insertResult(result(seq));
      traces.insertTrace(`job-${seq}`, [
        {
          layer: 'FILETYPE',
          status,
          reason: 'test',
          hits: seq === 0 ? 2 : 0,
          points: seq === 0 ? 50 : 0,
          ms: 0.5,
        },
      ]);
    }
    results.insertComplete(complete(0, 'other'));
    expect(traces.aggregateByJob('job')).toEqual([
      {
        layer: 'FILETYPE',
        files: 4,
        ran: 1,
        skipped: 1,
        disabled: 1,
        errors: 1,
        hits: 2,
        points: 50,
        ms: 2,
      },
    ]);
    expect(traces.aggregateByJob('missing')).toEqual([]);
  });

  it.each(['ERROR', 'SKIPPED'] as const)(
    'guarda %s sin fabricar puntuación ni evaluación',
    (status) => {
      const saved = results.insertComplete({
        result: { ...result(), status, errorCode: 'IO_ERROR' },
        evidence: [],
        layers: layers.map((l) => ({
          ...l,
          status: 'SKIPPED',
          reason: 'IO_ERROR',
          hits: 0,
          points: 0,
        })),
        assessment: null,
      });
      expect(saved).toMatchObject({
        status,
        verdict: 'NOT_ANALYZED',
        engineScore: null,
        riskLevel: null,
      });
      expect(risks.get(saved.id)).toBeUndefined();
      expect(traces.listByResult(saved.id)).toHaveLength(3);
    },
  );

  it('exige evaluación para análisis completado o evidencia decisiva', () => {
    expect(() =>
      results.insertComplete({ ...complete(), assessment: null }),
    ).toThrow('requiere evaluación');
    expect(() =>
      results.insertComplete({
        ...complete(),
        result: { ...result(), status: 'ERROR' },
        assessment: null,
      }),
    ).toThrow('requiere evaluación');
    const saved = results.insertComplete({
      ...complete(),
      result: { ...result(), status: 'ERROR' },
    });
    expect(saved).toMatchObject({
      status: 'ERROR',
      verdict: 'DETECTED',
      engineScore: 85,
    });
  });

  it('rechaza evaluación duplicada, ausente o inválida y recupera su traza', () => {
    results.insertComplete(complete());
    const input = {
      ...complete().assessment!,
      resultId: 'job-0',
      reviewRequired: true,
      aiOpinion: 'LIKELY_BENIGN' as const,
      aiConfidence: 0.9,
    };
    expect(() => risks.insert(input)).toThrow('UNIQUE');
    expect(() => risks.insert({ ...input, resultId: 'missing' })).toThrow(
      'FOREIGN KEY',
    );
    expect(() =>
      results.insertComplete({
        ...complete(1),
        assessment: { ...input, traceJson: '{broken' },
      }),
    ).toThrow();
    expect(results.get('job-1')).toBeUndefined();
    results.insertResult(result(1));
    const stored = risks.insert({ ...input, resultId: 'job-1' });
    expect(stored).toMatchObject({
      reviewRequired: true,
      aiOpinion: 'LIKELY_BENIGN',
      aiConfidence: 0.9,
    });
  });

  it('almacena contexto exacto y su hash; conserva intentos inválidos sin alterar decisiones', () => {
    results.insertComplete(complete());
    const before = risks.get('job-0');
    const stored = ai.insert(analysis());
    expect(stored.contextJson).toBe(analysis().contextJson);
    expect(stored.contextSha256).toBe(
      createHash('sha256').update(analysis().contextJson).digest('hex'),
    );
    const bad = ai.insert({
      ...analysis('bad'),
      validationStatus: 'INVALID_JSON',
      responseJson: 'raw {malformed',
      inputTokens: 10,
      outputTokens: 2,
      latencyMs: 33,
    });
    expect(ai.get('bad')).toEqual(bad);
    expect(bad.responseJson).toBe('raw {malformed');
    expect(ai.latestValidByResult('job-0')).toEqual(stored);
    expect(risks.get('job-0')).toEqual(before);
    expect(results.get('job-0')?.aiStatus).toBe('PENDING');
  });

  it('elige último VALID por fecha y desempata por inserción, aislando resultados', () => {
    results.insertResult(result());
    results.insertResult(result(1));
    ai.insert(analysis('z-first'));
    const latest = ai.insert(analysis('a-second'));
    ai.insert({ ...analysis('old'), createdAt: '2026-09-29T12:00:00Z' });
    ai.insert({
      ...analysis('new-invalid'),
      createdAt: '2026-10-01T00:00:00Z',
      validationStatus: 'UNSAFE',
    });
    ai.insert(analysis('other-result', 'job-1'));
    expect(ai.latestValidByResult('job-0')).toEqual(latest);
    expect(ai.latestValidByResult('missing')).toBeUndefined();
    expect(ai.get('missing')).toBeUndefined();
  });

  it('admite resúmenes de trabajo y rechaza referencias incoherentes o inexistentes', () => {
    results.insertResult(result());
    expect(
      ai.insert({
        ...analysis(),
        kind: 'JOB_SUMMARY',
        resultId: null,
        jobId: 'job',
      }),
    ).toMatchObject({ kind: 'JOB_SUMMARY', resultId: null });
    expect(() => ai.insert(analysis())).toThrow('UNIQUE');
    expect(() => ai.insert(analysis('missing', 'absent'))).toThrow(
      'FOREIGN KEY',
    );
    expect(() =>
      ai.insert({ ...analysis('wrong-job'), jobId: 'other' }),
    ).toThrow('no pertenece');
    expect(() =>
      ai.insert({ ...analysis('no-result'), resultId: null }),
    ).toThrow();
    expect(() =>
      ai.insert({ ...analysis('no-job'), kind: 'JOB_SUMMARY', resultId: null }),
    ).toThrow();
  });

  it('consulta pendientes aun sin intentos, con paginación y actualización explícita', () => {
    for (const [seq, aiStatus] of (
      ['PENDING', 'RETRY_WAIT', 'RUNNING', 'COMPLETED', 'NOT_REQUIRED'] as const
    ).entries())
      results.insertResult({ ...result(seq), aiStatus });
    expect(count('ai_analyses')).toBe(0);
    expect(ai.listPendingByStatus().map((r) => r.id)).toEqual([
      'job-0',
      'job-1',
    ]);
    expect(
      ai.listPendingByStatus(['PENDING', 'RETRY_WAIT'], 1, 1).map((r) => r.id),
    ).toEqual(['job-1']);
    expect(ai.listPendingByStatus(['RUNNING']).map((r) => r.id)).toEqual([
      'job-2',
    ]);
    expect(ai.listPendingByStatus([])).toEqual([]);
    expect(ai.listPendingByStatus(['PENDING'], 0, 0)).toEqual([]);
    results.updateAIStatus('job-0', 'COMPLETED');
    expect(ai.listPendingByStatus().map((r) => r.id)).toEqual(['job-1']);
    expect(() => results.updateAIStatus('missing', 'PENDING')).toThrow(
      'No existe',
    );
    expect(() => results.updateAIStatus('job-1', 'BAD' as never)).toThrow();
  });

  it.each([-1, 1.5, NaN, Infinity])(
    'rechaza números inválidos sin escrituras: %s',
    (invalid) => {
      expect(() =>
        results.insertResult({ ...result(), engineScore: invalid }),
      ).toThrow();
      expect(() => ai.listPendingByStatus(['PENDING'], invalid, 10)).toThrow();
      expect(() => ai.listPendingByStatus(['PENDING'], 0, invalid)).toThrow();
      expect(count('scan_results')).toBe(0);
    },
  );

  it('borra todas las relaciones en cascada y conserva otros trabajos', () => {
    results.insertComplete(complete());
    results.insertComplete(complete(0, 'other'));
    ai.insert(analysis());
    ai.insert(analysis('kept', 'other-0'));
    ai.insert({
      ...analysis('summary'),
      kind: 'JOB_SUMMARY',
      resultId: null,
      jobId: 'job',
    });
    db.prepare('DELETE FROM scan_jobs WHERE id = ?').run('job');
    expect(results.get('job-0')).toBeUndefined();
    expect(evidences.listByResult('job-0')).toEqual([]);
    expect(traces.listByResult('job-0')).toEqual([]);
    expect(risks.get('job-0')).toBeUndefined();
    expect(ai.get('analysis')).toBeUndefined();
    expect(ai.get('summary')).toBeUndefined();
    expect(results.get('other-0')).toBeDefined();
    expect(ai.get('kept')).toBeDefined();
    expect(count('evidences')).toBe(1);
    expect(count('risk_assessments')).toBe(1);
    expect(count('result_layers')).toBe(3);
  });
});
