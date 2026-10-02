import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import { limitedRows, type ToolContext } from './context';

export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'get_quarantine_items',
    description:
      'Consulta ítems de cuarentena, sin secretos ni capacidad de restaurar o borrar.',
    arguments: z.strictObject({
      status: z
        .enum(['PENDING', 'QUARANTINED', 'RESTORED', 'DELETED', 'FAILED'])
        .nullish(),
    }),
    execute: ({ status }) => limitedRows(context.reads.quarantine(status), 20),
  });
}
