import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigStore, appConfigSchema } from '../src/core/config/AppConfig';
import { JobSummaryStore } from '../src/core/ai/JobSummaryStore';
import { ClaudeProvider } from '../src/core/ai/providers/ClaudeProvider';
vi.mock('electron', () => ({ app: {}, safeStorage: {} }));
import { AIFlowHarness } from './fixtures/AIFlowHarness';

// CI nunca llama a Claude, incluso si recibe una clave por error. Localmente requiere opt-in.
const skip =
  Boolean(process.env.CI) ||
  !process.env.CYBERSOC_ANTHROPIC_API_KEY?.trim() ||
  process.env.CYBERSOC_RUN_AI_LIVE !== '1';
if (skip)
  console.info(
    'JOB_SUMMARY_LIVE: OMITIDA. Requiere clave de desarrollo, CYBERSOC_RUN_AI_LIVE=1 y ejecución fuera de CI.',
  );

describe.skipIf(skip)('live — escaneo de fixtures → JOB_SUMMARY real', () => {
  let harness: AIFlowHarness | undefined;
  afterEach(async () => {
    await harness?.close();
  });

  it('resume un escaneo real de los fixtures con la API de Claude', async () => {
    const model = appConfigSchema.parse({}).ai.analysisModel;
    harness = new AIFlowHarness(
      () =>
        new ClaudeProvider({
          apiKey: process.env.CYBERSOC_ANTHROPIC_API_KEY!,
          model,
        }),
    );
    // Solo el resumen llama a la API: sin análisis automáticos de archivo (coste mínimo).
    new AppConfigStore(harness.db).save({ ai: { autoAnalyzeLimitPerScan: 0 } });
    await harness.prepare();
    const { job, results } = await harness.scan();
    expect(job.status).toBe('COMPLETED');

    const store = new JobSummaryStore(harness.db);
    harness.worker.start();
    await vi.waitFor(
      () =>
        expect([
          'COMPLETED',
          'INVALID',
          'NOT_CONFIGURED',
          'UNAVAILABLE',
          'RETRY_WAIT',
        ]).toContain(store.status(job.id)),
      { timeout: 90_000, interval: 250 },
    );
    await harness.worker.stop();

    const attempts = harness.db
      .prepare(
        `SELECT validation_status AS validationStatus, error_kind AS errorKind, model,
           prompt_version AS promptVersion, input_tokens AS inputTokens,
           output_tokens AS outputTokens, latency_ms AS latencyMs, context_sha256 AS contextSha256
         FROM ai_analyses WHERE job_id = ? AND kind = 'JOB_SUMMARY' ORDER BY rowid`,
      )
      .all(job.id);
    const context = JSON.parse(
      String(
        harness.db
          .prepare(
            "SELECT context_json FROM ai_analyses WHERE job_id = ? AND kind = 'JOB_SUMMARY' ORDER BY rowid LIMIT 1",
          )
          .get(job.id)!.context_json,
      ),
    );
    const saved = store.latestValid(job.id);
    // Salida para la evidencia: nunca contiene la clave.
    console.info(
      `JOB_SUMMARY_LIVE_RESULT\n${JSON.stringify(
        {
          jobStatus: job.status,
          resultsScanned: results.length,
          summaryStatus: store.status(job.id),
          attempts,
          contextSent: {
            counters: context.job.counters,
            verdicts: context.job.verdicts,
            topResults: context.topResults.map(
              (item: { resultId: string; verdict: string; score: number }) => ({
                resultId: item.resultId,
                verdict: item.verdict,
                score: item.score,
              }),
            ),
            constraints: context.constraints,
          },
          validatedSummary: saved?.summary ?? null,
        },
        null,
        2,
      )}`,
    );

    expect(store.status(job.id)).toBe('COMPLETED');
    expect(saved).toBeDefined();
    const last = attempts.at(-1)!;
    expect(last.validationStatus).toBe('VALID');
    expect(Number(last.inputTokens)).toBeGreaterThan(0);
    expect(Number(last.outputTokens)).toBeGreaterThan(0);
    const known = new Set(results.map((row) => row.id));
    expect(saved!.summary.citedResultIds.every((id) => known.has(id))).toBe(
      true,
    );
  }, 120_000);
});
