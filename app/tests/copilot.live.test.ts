import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfigSchema } from '../src/core/config/AppConfig';
import type {
  AIProvider,
  AIResult,
  AssistantTurnRequest,
} from '../src/core/ai/AIProvider';
import { ClaudeProvider } from '../src/core/ai/providers/ClaudeProvider';
import { FakeAIProvider } from '../src/core/ai/providers/FakeAIProvider';
import { AssistantOrchestrator } from '../src/core/ai/AssistantOrchestrator';
vi.mock('electron', async () => ({
  app: { getPath: (await import('node:os')).tmpdir },
  safeStorage: {},
}));
import { AIFlowHarness } from './fixtures/AIFlowHarness';

// CI nunca llama a Claude, incluso si recibe una clave por error. Localmente requiere opt-in.
const skip =
  Boolean(process.env.CI) ||
  !process.env.CYBERSOC_ANTHROPIC_API_KEY?.trim() ||
  process.env.CYBERSOC_RUN_AI_LIVE !== '1';
if (skip)
  console.info(
    'COPILOT_LIVE: OMITIDA. Requiere clave de desarrollo, CYBERSOC_RUN_AI_LIVE=1 y ejecución fuera de CI.',
  );

const QUESTIONS = [
  '¿Por qué fue marcado?',
  '¿Qué capa lo detectó?',
  '¿Qué debería hacer?',
] as const;

describe.skipIf(skip)('live — SOC Copilot v1 sobre la API de Claude', () => {
  let harness: AIFlowHarness | undefined;
  afterEach(async () => {
    await harness?.close();
  });

  it('responde tres preguntas reales sobre un fixture detectado sin cambiar su veredicto', async () => {
    const config = appConfigSchema.parse({});
    const claude = new ClaudeProvider({
      apiKey: process.env.CYBERSOC_ANTHROPIC_API_KEY!,
      model: config.ai.assistantModel,
    });
    // Registra uso y latencia de cada turno; no guarda la petición ni la clave.
    const usage: Array<Pick<AIResult<string>, 'ok'> & Record<string, unknown>> =
      [];
    const recording: AIProvider = {
      id: claude.id,
      healthCheck: () => claude.healthCheck(),
      generateStructured: (req) => claude.generateStructured(req),
      async runAssistantTurn(req: AssistantTurnRequest) {
        const result = await claude.runAssistantTurn(req);
        usage.push(
          result.ok
            ? {
                ok: true,
                model: result.model,
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                latencyMs: result.latencyMs,
              }
            : { ok: false, errorKind: result.error.kind },
        );
        return result;
      },
    };

    // El escaneo usa un proveedor falso: el análisis automático no gasta llamadas.
    harness = new AIFlowHarness(() => new FakeAIProvider());
    await harness.prepare();
    const { results } = await harness.scan(harness.signature);
    const detected = results[0]!;
    expect(detected.verdict).toBe('DETECTED');
    const verdictBefore = harness.db
      .prepare('SELECT verdict, risk_level FROM scan_results WHERE id = ?')
      .get(detected.id);

    const assistant = new AssistantOrchestrator({
      db: harness.db,
      provider: () => recording,
      readConfig: () => config,
    });
    const lines = [
      `Fecha UTC: ${new Date().toISOString()}`,
      'Prueba: tests/copilot.live.test.ts (T4.6, paso 6)',
      `Modelo configurado (ai.assistantModel): ${config.ai.assistantModel}`,
      `Fixture: ${detected.fileName} (generado por engine/tests/fixtures/generate.py; texto inofensivo, nunca EICAR)`,
      `Veredicto antes: ${JSON.stringify(verdictBefore)}`,
      'Foco: { resultId } del fixture detectado; historial en memoria (ventana de 10 turnos).',
      '',
    ];
    for (const [index, question] of QUESTIONS.entries()) {
      const reply = await assistant.ask({
        message: question,
        focus: { resultId: detected.id },
      });
      lines.push(
        `--- Turno ${index + 1} ---`,
        `Usuario: ${question}`,
        `Estado: ${reply.status}${reply.errorKind ? ` (${reply.errorKind})` : ''} · turnos en la ventana: ${reply.historyTurns}`,
        `Uso: ${JSON.stringify(usage[index])}`,
        'SOC Copilot:',
        reply.text,
        '',
      );
      expect(reply.status).toBe('ANSWERED');
    }
    const verdictAfter = harness.db
      .prepare('SELECT verdict, risk_level FROM scan_results WHERE id = ?')
      .get(detected.id);
    lines.push(`Veredicto después: ${JSON.stringify(verdictAfter)}`);
    expect(verdictAfter).toEqual(verdictBefore);

    const transcript = lines.join('\n');
    expect(transcript).not.toContain(process.env.CYBERSOC_ANTHROPIC_API_KEY!);
    if (process.env.CYBERSOC_COPILOT_TRANSCRIPT)
      writeFileSync(
        process.env.CYBERSOC_COPILOT_TRANSCRIPT,
        transcript,
        'utf8',
      );
    console.info(transcript);
  }, 120_000);
});
