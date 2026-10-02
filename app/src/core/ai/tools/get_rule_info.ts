import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import { idSchema, type ToolContext } from './context';

export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'get_rule_info',
    description:
      'Descripción, severidad y condiciones resumidas de una regla del catálogo local.',
    arguments: z.strictObject({ ruleId: idSchema }),
    execute: ({ ruleId }) => context.catalog.rule(ruleId),
  });
}
