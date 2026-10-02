import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import { idSchema, type ToolContext } from './context';

export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'compare_results',
    description:
      'Compara veredictos, puntuaciones y códigos de evidencia de dos resultados.',
    arguments: z.strictObject({ resultIdA: idSchema, resultIdB: idSchema }),
    execute: ({ resultIdA, resultIdB }) => {
      const a = context.reads.result(resultIdA),
        b = context.reads.result(resultIdB);
      const evidenceA = context.reads.evidence(resultIdA),
        evidenceB = context.reads.evidence(resultIdB);
      const same = (
        left: (typeof evidenceA)[number],
        right: (typeof evidenceA)[number],
      ) =>
        left.source === right.source &&
        left.code === right.code &&
        left.severity === right.severity &&
        left.points === right.points &&
        left.decisive === right.decisive;
      return {
        a,
        b,
        scoreDelta:
          a.engineScore === null || b.engineScore === null
            ? null
            : a.engineScore - b.engineScore,
        sameVerdict: a.verdict === b.verdict,
        onlyA: evidenceA.filter(
          (item) => !evidenceB.some((other) => same(item, other)),
        ),
        onlyB: evidenceB.filter(
          (item) => !evidenceA.some((other) => same(item, other)),
        ),
      };
    },
  });
}
