import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import { limitSchema, limitedRows, type ToolContext } from './context';

export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'list_scans',
    description: 'Lista los escaneos más recientes, hasta 20.',
    arguments: z.strictObject({ limit: limitSchema }),
    execute: ({ limit }) =>
      limitedRows(context.reads.jobs((limit ?? 20) + 1), limit ?? 20),
  });
}
