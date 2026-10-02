import type { Database } from '../src/core/persistence/Database';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { AIAnalysisRepository } from '../src/core/persistence/AIAnalysisRepository';

export const hostileName = '<script>alert(1)</script>.exe';
export function seedReports(db: Database): void {
  const jobs = new ScanJobRepository(db);
  for (const id of ['j1', 'j2'])
    jobs.create({
      id,
      targetPath: `C:\\Fixtures\\${id}`,
      targetKind: 'FOLDER',
      createdAt: '2026-10-02T00:00:00.000Z',
      engineVersion: 'engine-test',
      signaturesVersion: 'sig-test',
      rulesetVersion: 'rules-test',
    });
  const results = new ScanResultRepository(db);
  for (let i = 0; i < 4; i++)
    results.insertComplete({
      result: {
        id: `r${i}`,
        jobId: i < 3 ? 'j1' : 'j2',
        seq: i,
        path: `C:\\Fixtures\\${i}.txt`,
        fileName: [
          hostileName,
          'informe, "niño".txt',
          '=SUM(1,2).txt',
          'limpio.txt',
        ][i]!,
        status: 'SCANNED',
        sizeBytes: 20,
        sha256: String(i).repeat(64),
        scannedAt: `2026-10-0${i + 1}T12:00:00.000Z`,
        zone: i % 2 ? 'SISTEMA' : 'DESCARGAS',
      },
      evidence: [
        {
          id: 'ev1',
          source: 'FILETYPE',
          code: 'DOUBLE_EXTENSION',
          title: '<img src=x onerror=alert(2)> & "prueba"',
          severity: 'MEDIUM',
          points: 15,
          decisive: false,
          confidence: 1,
          facts: {},
        },
      ],
      layers: [
        { layer: 'HASH', status: 'RAN', hits: 0, points: 0, ms: 2 },
        { layer: 'FILETYPE', status: 'RAN', hits: 1, points: 15, ms: 1 },
      ],
      assessment: {
        engineVerdict: i % 2 ? 'CLEAN' : 'SUSPICIOUS',
        engineScore: i % 2 ? 0 : 30,
        finalVerdict: i % 2 ? 'CLEAN' : 'SUSPICIOUS',
        finalLevel: i % 2 ? 'BAJO' : 'MEDIO',
        reviewRequired: false,
        origin: 'ENGINE',
        traceJson: '[]',
        policyVersion: '3',
        decidedAt: '2026-10-02T12:00:00.000Z',
      },
    });
  new AIAnalysisRepository(db).insert({
    id: 'ai1',
    kind: 'FILE_RESULT',
    resultId: 'r0',
    provider: 'fake',
    model: 'fake-test',
    promptVersion: 'v1',
    contextJson: '{"secret":"NOT_EXPORTED"}',
    responseJson: JSON.stringify({
      summary: '<script>alert(3)</script> & texto de IA',
      total: 9999,
    }),
    validationStatus: 'VALID',
    createdAt: '2026-10-02T12:00:00.000Z',
  });
}
