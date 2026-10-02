import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import { idSchema, optionalJob, type ToolContext } from './context';
import { zoneSchema } from '../../../shared/protocol';

const args = z
  .strictObject({
    resultId: idSchema.nullish(),
    jobId: optionalJob,
    zone: zoneSchema.nullish(),
  })
  .refine(
    (input) =>
      input.resultId != null
        ? input.jobId == null && input.zone == null
        : input.jobId != null || input.zone != null,
    'Indica resultado, escaneo o zona (opcionalmente dentro de un escaneo).',
  );
export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'get_layer_report',
    description:
      'Agrega capas por resultado, escaneo o zona: estados, motivos, aciertos, puntos y duración.',
    arguments: args,
    execute: (scope) => ({ scope, rows: context.reads.layerReport(scope) }),
  });
}
