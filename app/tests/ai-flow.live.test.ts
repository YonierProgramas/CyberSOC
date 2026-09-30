import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIAnalysisRepository } from '../src/core/persistence/AIAnalysisRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { ClaudeProvider } from '../src/core/ai/providers/ClaudeProvider';
import { appConfigSchema } from '../src/core/config/AppConfig';
vi.mock('electron', () => ({ app: {}, safeStorage: {} }));
import { AIFlowHarness } from './fixtures/AIFlowHarness';

// CI nunca llama a Claude, incluso si recibe una clave por error. Localmente requiere opt-in.
const skip =
  Boolean(process.env.CI) ||
  !process.env.CYBERSOC_ANTHROPIC_API_KEY?.trim() ||
  process.env.CYBERSOC_RUN_AI_LIVE !== '1';
if (skip)
  console.info(
    'AI_LIVE: OMITIDA. Requiere clave de desarrollo, CYBERSOC_RUN_AI_LIVE=1 y ejecución fuera de CI.',
  );

describe.skipIf(skip)(
  'live — firma de prueba → API de Claude → VALID persistido',
  () => {
    let harness: AIFlowHarness | undefined;
    afterEach(async () => {
      await harness?.close();
    });

    it('guarda un análisis real VALID con tokens positivos y conserva DETECTED', async () => {
      const model = appConfigSchema.parse({}).ai.analysisModel;
      harness = new AIFlowHarness(
        () =>
          new ClaudeProvider({
            apiKey: process.env.CYBERSOC_ANTHROPIC_API_KEY!,
            model,
          }),
      );
      await harness.prepare();
      const { job, results } = await harness.scan(harness.signature);
      expect(job.status).toBe('COMPLETED');
      const id = results[0]!.id;
      expect(results[0]!.verdict).toBe('DETECTED');
      const completed = new Promise<string>((resolve) => {
        harness!.worker.on('ai:resultUpdated', (event) => {
          if (
            event.resultId === id &&
            [
              'COMPLETED',
              'INVALID',
              'RETRY_WAIT',
              'NOT_CONFIGURED',
              'UNAVAILABLE',
            ].includes(event.aiStatus)
          )
            resolve(event.aiStatus);
        });
      });
      harness.worker.start();
      // Una ejecución del flujo: hasta dos intentos de validación; sin repetir fallos de red.
      const state = await completed;
      await harness.worker.stop();
      const saved = new AIAnalysisRepository(harness.db).latestValidByResult(
        id,
      );
      const tokens = (saved?.inputTokens ?? 0) + (saved?.outputTokens ?? 0);
      // Solo datos acotados de auditoría: ni respuesta, contexto, error HTTP ni credencial.
      console.info(
        'AI_LIVE_RESULT',
        JSON.stringify({
          fixture: 'CSD-TEST-001',
          status: state,
          validation: saved?.validationStatus ?? null,
          modelConfigured: model,
          inputTokens: saved?.inputTokens ?? null,
          outputTokens: saved?.outputTokens ?? null,
          latencyMs: saved?.latencyMs ?? null,
        }),
      );
      expect(state).toBe('COMPLETED');
      expect(saved?.validationStatus).toBe('VALID');
      expect(tokens).toBeGreaterThan(0);
      expect(saved?.inputTokens).toBeGreaterThan(0);
      expect(saved?.outputTokens).toBeGreaterThan(0);
      expect(new ScanResultRepository(harness.db).get(id)?.verdict).toBe(
        'DETECTED',
      );
    }, 90_000);
  },
);
