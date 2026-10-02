import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import { idSchema, type ToolContext } from './context';

export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'get_evidence',
    description:
      'Evidencias de un resultado; los IDs evN pertenecen a ese resultado.',
    arguments: z.strictObject({ resultId: idSchema }),
    execute: ({ resultId }) => ({
      resultId,
      rows: context.reads.evidence(resultId),
    }),
  });
}
