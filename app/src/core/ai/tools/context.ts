import { z } from 'zod';
import { topK } from '../../structures/TopK';
import type { ZoneRoot } from '../../zones/ZoneClassifier';
import type { ToolCatalogRepository } from '../../persistence/ToolCatalogRepository';
import type { ToolReadRepository } from '../../persistence/ToolReadRepository';

/** main aporta rutas resueltas y unidades conectadas; la IA nunca proporciona rutas. */
export interface ToolContext {
  reads: ToolReadRepository;
  catalog: ToolCatalogRepository;
  zoneRoots: () => readonly ZoneRoot[];
  removableDrives: () => Promise<readonly { driveId: string; path: string }[]>;
}
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((id) => id.trim() === id && !id.includes('\0'));
export const limitSchema = z.number().int().min(1).max(20).nullish();
export const optionalJob = idSchema.nullish();

export function topResults(context: ToolContext, jobId: string, k: number) {
  // TopK usa min-heap: O(n log k), memoria O(k), empate por seq del iterador SQL.
  return topK(
    context.reads.riskCandidates(jobId),
    k,
    (result) => result.engineScore!,
  );
}
export function limitedRows<T>(rows: T[], limit: number) {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}
