import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import { idSchema, type ToolContext } from './context';

export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'get_result_detail',
    description:
      'Archivo, SHA-256, veredicto, riesgo y traza de capas de un resultado.',
    arguments: z.strictObject({ resultId: idSchema }),
    execute: ({ resultId }) => ({
      result: context.reads.result(resultId),
      layers: context.reads.layers(resultId),
    }),
  });
}
