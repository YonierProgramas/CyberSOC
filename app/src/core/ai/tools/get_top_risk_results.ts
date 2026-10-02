import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import { optionalJob, topResults, type ToolContext } from './context';

export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'get_top_risk_results',
    description: 'Top-k real por puntuación del motor, con empate por llegada.',
    arguments: z.strictObject({
      jobId: optionalJob,
      k: z.number().int().min(1).max(10).nullish(),
    }),
    execute: ({ jobId, k }) => {
      const job = context.reads.job(jobId);
      return {
        jobId: job.id,
        rows: topResults(context, String(job.id), k ?? 10),
      };
    },
  });
}
