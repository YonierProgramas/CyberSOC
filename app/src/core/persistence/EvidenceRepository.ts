import { randomUUID } from 'node:crypto';
import { evidenceSchema, type Evidence } from '../../shared/protocol';
import type { Database } from './Database';

export interface EvidenceRecord extends Omit<Evidence, 'id' | 'facts'> {
  id: string;
  resultId: string;
  evidenceKey: string;
  detailsJson: string;
}

export class EvidenceRepository {
  constructor(private readonly database: Database) {}

  insertMany(resultId: string, evidence: readonly Evidence[]): void {
    this.database.transaction(() => {
      const insert = this.database.prepare(`INSERT INTO evidences
        (id, result_id, evidence_key, source, code, title, severity, points,
         decisive, confidence, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const value of evidence) {
        const item = evidenceSchema.parse(value);
        // ev1 identifica evidencia dentro de UN resultado; el UUID es global.
        insert.run(
          randomUUID(),
          resultId,
          item.id,
          item.source,
          item.code,
          item.title,
          item.severity,
          item.points,
          Number(item.decisive),
          item.confidence,
          JSON.stringify(item.facts),
        );
      }
    });
  }

  listByResult(resultId: string): EvidenceRecord[] {
    // Las claves evN se ordenan por su parte numérica: ev2 precede a ev10.
    const rows = this.database
      .prepare(
        `SELECT id, result_id AS resultId,
      evidence_key AS evidenceKey, source, code, title, severity, points,
      decisive, confidence, details_json AS detailsJson FROM evidences
      WHERE result_id = ? ORDER BY length(evidence_key), evidence_key`,
      )
      .all(resultId);
    return rows.map((row) => ({
      ...row,
      decisive: row.decisive === 1,
    })) as unknown as EvidenceRecord[];
  }
}
