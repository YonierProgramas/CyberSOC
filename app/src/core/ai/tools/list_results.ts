import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import {
  idSchema,
  limitSchema,
  limitedRows,
  type ToolContext,
} from './context';

export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'list_results',
    description:
      'Consulta resultados de un escaneo por veredicto y puntuación mínima.',
    arguments: z.strictObject({
      jobId: idSchema,
      verdict: z
        .enum([
          'CLEAN',
          'SUSPICIOUS',
          'DETECTED',
          'NOT_ANALYZED',
          'NOT_EVALUATED',
        ])
        .nullish(),
      minScore: z.number().int().min(0).max(100).nullish(),
      limit: limitSchema,
    }),
    execute: ({ jobId, verdict, minScore, limit }) =>
      limitedRows(
        context.reads.results(jobId, (limit ?? 20) + 1, verdict, minScore),
        limit ?? 20,
      ),
  });
}
