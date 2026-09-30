import { layerTraceSchema, type LayerTrace } from '../../shared/protocol';
import type { Database } from './Database';

export interface LayerTraceRecord extends Omit<LayerTrace, 'reason'> {
  resultId: string;
  reason: string | null;
}

export interface LayerAggregate {
  layer: LayerTrace['layer'];
  files: number;
  ran: number;
  skipped: number;
  disabled: number;
  errors: number;
  hits: number;
  points: number;
  ms: number;
}

export class LayerTraceRepository {
  constructor(private readonly database: Database) {}

  insertTrace(resultId: string, layers: readonly LayerTrace[]): void {
    this.database.transaction(() => {
      const insert = this.database.prepare(`INSERT INTO result_layers
        (result_id, layer, status, reason, hits, points, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const value of layers) {
        const layer = layerTraceSchema.parse(value);
        insert.run(
          resultId,
          layer.layer,
          layer.status,
          layer.reason ?? null,
          layer.hits,
          layer.points,
          layer.ms,
        );
      }
    });
  }

  listByResult(resultId: string): LayerTraceRecord[] {
    return this.database
      .prepare(
        `SELECT result_id AS resultId, layer, status,
      reason, hits, points, duration_ms AS ms FROM result_layers
      WHERE result_id = ? ORDER BY CASE layer
        WHEN 'HASH' THEN 0 WHEN 'SIGNATURES' THEN 1 WHEN 'FILETYPE' THEN 2
        WHEN 'RULES' THEN 3 WHEN 'HEURISTICS' THEN 4 WHEN 'PE' THEN 5 ELSE 6 END
    `,
      )
      .all(resultId) as unknown as LayerTraceRecord[];
  }

  aggregateByJob(jobId: string): LayerAggregate[] {
    // SQLite agrega solo las filas del trabajo solicitado; no carga cada traza
    // en memoria de la app. hits cuenta hallazgos, files cuenta archivos.
    return this.database
      .prepare(
        `SELECT l.layer, COUNT(*) AS files,
      SUM(l.status = 'RAN') AS ran, SUM(l.status = 'SKIPPED') AS skipped,
      SUM(l.status = 'DISABLED') AS disabled, SUM(l.status = 'ERROR') AS errors,
      SUM(l.hits) AS hits, SUM(l.points) AS points,
      COALESCE(SUM(l.duration_ms), 0) AS ms
      FROM result_layers l JOIN scan_results r ON r.id = l.result_id
      WHERE r.job_id = ? GROUP BY l.layer ORDER BY l.layer
    `,
      )
      .all(jobId) as unknown as LayerAggregate[];
  }
}
