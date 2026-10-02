import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import { optionalJob, topResults, type ToolContext } from './context';

const args = z.strictObject({ jobId: optionalJob });
export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'get_scan_summary',
    description: 'Resume un escaneo real; sin jobId usa el más reciente.',
    arguments: args,
    execute: ({ jobId }) => {
      const job = context.reads.job(jobId);
      const durationMs =
        job.startedAt && job.finishedAt
          ? Math.max(
              0,
              Date.parse(String(job.finishedAt)) -
                Date.parse(String(job.startedAt)),
            )
          : null;
      return {
        job,
        counts: context.reads.counts(String(job.id)),
        durationMs,
        topResults: topResults(context, String(job.id), 5),
        aiSummary: context.reads.analysis('JOB_SUMMARY', String(job.id)),
      };
    },
  });
}
