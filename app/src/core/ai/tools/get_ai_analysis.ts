import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import { idSchema, type ToolContext } from './context';

export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'get_ai_analysis',
    description: 'Último análisis de IA validado; devuelve null si no existe.',
    arguments: z.strictObject({ resultId: idSchema }),
    execute: ({ resultId }) => {
      context.reads.result(resultId);
      return {
        resultId,
        analysis: context.reads.analysis('FILE_RESULT', resultId),
      };
    },
  });
}
