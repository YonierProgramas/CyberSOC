import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  evaluate,
  fakeProvider,
  judge,
  loadScenarios,
  main,
  passed,
  percentile,
  report,
  scenarioSchema,
  type Scenario,
} from '../../scripts/ai-eval';
import { FakeAIProvider } from '../../src/core/ai/providers/FakeAIProvider';
import type { AIResult } from '../../src/core/ai/AIProvider';
import type { AIAssessment } from '../../src/core/ai/schemas';

const scenarios = await loadScenarios();
const samples = JSON.parse(
  await readFile(new URL('./fake-responses.json', import.meta.url), 'utf8'),
) as AIAssessment[];
const temporary: string[] = [];
const ok = (assessment = samples[0]!): AIResult<AIAssessment> => ({
  ok: true,
  value: assessment,
  model: 'fake-eval',
  usage: { inputTokens: 100, outputTokens: 20 },
  latencyMs: 7,
});
async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'cybersoc-eval-test-'));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe('ai:eval — corpus y métricas', () => {
  it('incluye 15 contextos, todos los casos del plan y benignos susceptibles de escalar', () => {
    expect(scenarios).toHaveLength(15);
    expect(scenarios.every((s) => scenarioSchema.safeParse(s).success)).toBe(
      true,
    );
    expect(
      scenarios.filter(
        (s) =>
          s.expectations.benign &&
          s.context.engine.score! > 0 &&
          s.context.engine.verdict === 'CLEAN',
      ),
    ).toHaveLength(4);
    expect(
      scenarios.some((s) => s.context.file.name.includes('ignora evidencias')),
    ).toBe(true);
    expect(
      scenarios.some((s) =>
        s.context.layers?.some((l) => l.status === 'DISABLED'),
      ),
    ).toBe(true);
    expect(
      scenarios.flatMap((s) => s.context.evidence.map((e) => e.code)),
    ).toEqual(
      expect.arrayContaining([
        'HIGH_ENTROPY',
        'DOUBLE_EXTENSION',
        'KNOWN_SIGNATURE',
        'SCRIPT_ENCODED_COMMAND',
        'PE_SUSPICIOUS_IMPORTS',
      ]),
    );
  });

  it('fake recorre exactamente una vez los 15 casos, usa prompt v2 y no envía expectativas', async () => {
    const network = vi.fn(() => {
      throw new Error('Prohibido usar red');
    });
    vi.stubGlobal('fetch', network);
    const provider = await fakeProvider();
    const checkpoint = vi.fn(async () => {});
    const rows = await evaluate(scenarios, provider, checkpoint);
    expect(rows.every(passed)).toBe(true);
    expect(provider.requests).toHaveLength(15);
    expect(checkpoint).toHaveBeenCalledTimes(15);
    expect(network).not.toHaveBeenCalled();
    for (const request of provider.requests) {
      expect(request.system).toContain('Correlaciones');
      expect(request.prompt).not.toContain('acceptableOpinions');
      expect(request.prompt).not.toContain('Respuesta simulada');
    }
    expect(rows[2]?.finalVerdict).toBe('DETECTED');
    expect(rows[6]?.policyRule).toBe('CLEAN_ESCALATED_BY_AI');
  });

  it('rechaza una cita inventada en lista, correlación o prosa usando el validador real', () => {
    for (const change of [
      { citedEvidenceIds: ['ev999'] },
      {
        correlations: [
          { evidenceIds: ['ev999'], insight: 'Indicio desconocido.' },
        ],
      },
      { technicalAnalysis: 'Se apoya en ev999.' },
    ]) {
      const row = judge(scenarios[0]!, ok({ ...samples[0]!, ...change }), 5);
      expect(row.schemaValid).toBe(true);
      expect(row.citationsValid).toBe(false);
      expect(row.status).toBe('UNKNOWN_EVIDENCE');
      expect(row.escalated).toBe(false);
      expect(passed(row)).toBe(false);
    }
  });

  it('cuenta citas distintas y separa opinión incoherente de esquema válido', () => {
    const scenario = scenarios[14]!;
    const repeated = judge(
      scenario,
      ok({ ...samples[14]!, citedEvidenceIds: ['ev1', 'ev1'] }),
      5,
    );
    expect(repeated.citationsValid).toBe(true);
    expect(repeated.minCitationsMet).toBe(false);
    const mismatch = judge(
      scenario,
      ok({ ...samples[14]!, opinion: 'LIKELY_BENIGN' }),
      5,
    );
    expect(mismatch.schemaValid).toBe(true);
    expect(mismatch.coherent).toBe(false);
  });

  it('detecta realmente el escalamiento benigno por RiskPolicy v2', () => {
    const row = judge(
      scenarios[0]!,
      ok({ ...samples[0]!, opinion: 'SUSPICIOUS', confidence: 0.9 }),
      5,
    );
    expect(row.escalated).toBe(true);
    expect(row.finalVerdict).toBe('SUSPICIOUS');
    expect(row.noEscalationMet).toBe(false);
    expect(passed(row)).toBe(false);
    expect(report([row], 15, false, '2026-10-01')).toContain(
      '1; 1 casos CLEAN benignos intentados',
    );
  });

  it('incluye tokens de respuestas inválidas, inseguras e incompletas', async () => {
    const provider = new FakeAIProvider()
      .enqueueRaw('{}', { usage: { inputTokens: 100, outputTokens: 50 } })
      .enqueueRaw(
        JSON.stringify({ ...samples[1], summary: 'https://example.invalid' }),
      )
      .enqueueRaw(JSON.stringify(samples[2]), {
        stopReason: 'max_tokens',
        usage: { inputTokens: 200, outputTokens: 100 },
      });
    const rows = await evaluate(scenarios.slice(0, 3), provider);
    expect(rows.map((r) => r.status)).toEqual([
      'INVALID_OUTPUT',
      'UNSAFE',
      'INCOMPLETE',
    ]);
    expect(rows[0]?.schemaValid).toBe(false);
    expect(rows[1]?.citationsValid).toBe(true);
    expect(rows[2]?.valid).toBe(false);
    const text = report(rows, 3, false, '2026-10-01');
    expect(text).toContain('300 / 150');
    expect(text).toContain('0.001050');
    expect(text).toContain('HAY INCUMPLIMIENTOS');
  });

  it('no reintenta 429, AUTH ni timeout; no imprime mensajes del proveedor', async () => {
    const provider = new FakeAIProvider()
      .enqueueError('RATE_LIMIT', { message: 'secret-sentinel' })
      .enqueueError('AUTH')
      .enqueueError('TIMEOUT');
    const rows = await evaluate(scenarios.slice(0, 3), provider);
    expect(provider.requests).toHaveLength(3);
    expect(rows.every((r) => !passed(r))).toBe(true);
    const text = report(rows, 15, false, '2026-10-01');
    expect(text).toContain('0/15 (0.0 %)');
    expect(text).toContain('INCOMPLETA');
    expect(text).toContain('parcial: faltan tokens');
    expect(text).not.toContain('secret-sentinel');
  });

  it('captura excepciones inesperadas sin revelar secretos ni ocultar los casos siguientes', async () => {
    const provider = await fakeProvider();
    vi.spyOn(provider, 'generateStructured').mockRejectedValueOnce(
      new Error('secret-sentinel'),
    );
    const rows = await evaluate(scenarios.slice(0, 2), provider);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('PROVIDER_DOWN');
    expect(JSON.stringify(rows)).not.toContain('secret-sentinel');
  });

  it('percentiles de rango próximo no mutan datos, incluidos conjunto vacío y singleton', () => {
    const numbers = [50, 10, 40, 30, 20];
    expect(percentile(numbers, 0.5)).toBe(30);
    expect(percentile(numbers, 0.95)).toBe(50);
    expect(numbers).toEqual([50, 10, 40, 30, 20]);
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
    expect(() => percentile(numbers, 0)).toThrow();
  });

  it('valida fixtures antes de consumir tokens', async () => {
    const bad: Scenario = structuredClone(scenarios[0]!);
    bad.expectations.minCitations = 2;
    expect(scenarioSchema.safeParse(bad).success).toBe(false);
    const dir = await temp();
    await writeFile(join(dir, 'one.json'), JSON.stringify(scenarios[0]));
    await writeFile(join(dir, 'two.json'), JSON.stringify(scenarios[0]));
    await expect(loadScenarios(dir)).rejects.toThrow('repetido');
  });
});

describe('ai:eval — comando y evidencia', () => {
  it('ejecuta el comando real en modo fake sin credenciales, conserva el reporte y no permite sobrescribir', async () => {
    const dir = await temp();
    const output = join(dir, 'fake.md');
    const app = fileURLToPath(new URL('../../', import.meta.url));
    // Import meta está en tests/ai-eval: dos niveles llevan a app/.
    const args = [
      '--experimental-transform-types',
      '--import',
      './tests/ai-eval/register.mjs',
      'scripts/ai-eval.ts',
      '--fake',
      '--output',
      output,
    ];
    const env = { ...process.env, CI: '1', CYBERSOC_ANTHROPIC_API_KEY: '' };
    const first = spawnSync(process.execPath, args, {
      cwd: app,
      env,
      encoding: 'utf8',
    });
    expect(first.stderr, first.stdout).not.toContain('SyntaxError');
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const contents = await readFile(output, 'utf8');
    expect(contents).toContain('FAKE — simulación sin red');
    expect(contents).toContain('15/15 (100.0 %)');
    expect(contents).not.toContain('\0');
    const second = spawnSync(process.execPath, args, {
      cwd: app,
      env,
      encoding: 'utf8',
    });
    expect(second.status).toBe(2);
    expect(await readFile(output, 'utf8')).toBe(contents);
  }, 30_000);

  it('rechaza live en CI, clave ausente, argumentos erróneos y fake sobre evidencia real', async () => {
    vi.stubEnv('CI', '1');
    await expect(main([])).rejects.toThrow('CI solo');
    vi.stubEnv('CI', '');
    vi.stubEnv('CYBERSOC_ANTHROPIC_API_KEY', '');
    await expect(main([])).rejects.toThrow('Falta CYBERSOC_');
    await expect(main(['--output'])).rejects.toThrow('Uso:');
    await expect(main(['--fake', '--typo'])).rejects.toThrow('Uso:');
    await expect(
      main(['--fake', '--output', join(await temp(), '08-ai-eval.md')]),
    ).rejects.toThrow('se reserva');
  });
});
