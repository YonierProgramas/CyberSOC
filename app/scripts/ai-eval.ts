import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AIProvider, AIResult, AIUsage } from '../src/core/ai/AIProvider';
import { toPromptSafeJson } from '../src/core/ai/AIContextBuilder';
import { validateAIResponse } from '../src/core/ai/AIResponseValidator';
import {
  buildAnalysisRequest,
  PROMPT_VERSION,
} from '../src/core/ai/prompts/analysis.v2';
import { ClaudeProvider } from '../src/core/ai/providers/ClaudeProvider';
import { FakeAIProvider } from '../src/core/ai/providers/FakeAIProvider';
import {
  aiAssessmentSchema,
  aiContextSchema,
  aiOpinionSchema,
  type AIAssessment,
} from '../src/core/ai/schemas';
import { decideRisk, POLICY_VERSION } from '../src/core/risk/RiskPolicy';

export const MODEL = 'claude-haiku-4-5-20251001';
export const PRICING = {
  input: 1,
  output: 5,
  checked: '2026-10-01',
  source: 'https://www.anthropic.com/claude/haiku',
};
const scenarioDirectory = fileURLToPath(
  new URL('../tests/ai-eval/scenarios/', import.meta.url),
);
export const scenarioSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    context: aiContextSchema,
    expectations: z.strictObject({
      benign: z.boolean(),
      acceptableOpinions: z.array(aiOpinionSchema).min(1),
      noEscalation: z.boolean(),
      minCitations: z.number().int().min(0).max(20),
    }),
  })
  .superRefine((s, ctx) => {
    if (s.expectations.minCitations > s.context.evidence.length)
      ctx.addIssue({ code: 'custom', message: 'Citas mínimas imposibles.' });
    if (s.expectations.benign && !s.expectations.noEscalation)
      ctx.addIssue({
        code: 'custom',
        message: 'Un caso benigno debe exigir no escalar.',
      });
    if (
      !['CLEAN', 'SUSPICIOUS', 'DETECTED'].includes(s.context.engine.verdict) ||
      s.context.engine.score === null
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Se requiere un resultado puntuado para evaluar RiskPolicy.',
      });
  });
export type Scenario = z.infer<typeof scenarioSchema>;

export async function loadScenarios(
  directory = scenarioDirectory,
): Promise<Scenario[]> {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.json'))
    .sort();
  if (!files.length) throw new Error('No hay escenarios.');
  const scenarios: Scenario[] = [];
  // Invariante: seen contiene exactamente los ids ya leídos, sin duplicados.
  // Set inserta y consulta en O(1) promedio: validar n ids cuesta O(n), con O(n) memoria.
  const seen = new Set<string>();
  for (const file of files) {
    const parsed = scenarioSchema.safeParse(
      JSON.parse(await readFile(join(directory, file), 'utf8')),
    );
    if (!parsed.success) throw new Error('Escenario inválido.');
    if (seen.has(parsed.data.id)) throw new Error('ID de escenario repetido.');
    seen.add(parsed.data.id);
    scenarios.push(parsed.data);
  }
  return scenarios;
}

export interface EvalRow {
  id: string;
  benign: boolean;
  eligibleBenign: boolean;
  contextSha256: string;
  responseSha256: string | null;
  schemaValid: boolean;
  citationsValid: boolean;
  minCitationsMet: boolean;
  coherent: boolean;
  noEscalationMet: boolean;
  escalated: boolean;
  valid: boolean;
  status: string;
  opinion: string | null;
  citedIds: string[];
  finalVerdict: string;
  policyRule: string;
  latencyMs: number;
  usage: AIUsage | null;
  model: string | null;
}

export function judge(
  scenario: Scenario,
  result: AIResult<AIAssessment>,
  latencyMs: number,
): EvalRow {
  const meta = result.ok ? result : result.error;
  const rawText =
    meta.rawText ?? (result.ok ? JSON.stringify(result.value) : '');
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    json = null;
  }
  const parsed = aiAssessmentSchema.safeParse(json);
  // Sin truncamiento se puede distinguir citas inválidas de una respuesta cortada.
  // El validador real comprueba también IDs en correlaciones y en toda la prosa.
  const content = validateAIResponse({
    rawText,
    context: scenario.context,
    truncated: false,
  });
  const validation = validateAIResponse({
    rawText,
    context: scenario.context,
    truncated: !result.ok && result.error.kind === 'INCOMPLETE',
  });
  const valid = result.ok && validation.status === 'VALID';
  const engine = scenario.context.engine;
  const decision = decideRisk(
    {
      verdict: engine.verdict as 'CLEAN' | 'SUSPICIOUS' | 'DETECTED',
      score: engine.score!,
      evidenceIds: scenario.context.evidence.map((e) => e.id),
    },
    valid && validation.status === 'VALID'
      ? {
          validationStatus: 'VALID',
          opinion: validation.assessment.opinion,
          confidence: validation.assessment.confidence,
          citedEvidenceIds: validation.assessment.citedEvidenceIds,
        }
      : { validationStatus: 'PROVIDER_ERROR' },
  );
  const citationsValid =
    content.status === 'VALID' || content.status === 'UNSAFE';
  const citedIds = parsed.success ? parsed.data.citedEvidenceIds : [];
  // Set evita que repetir ev1 satisfaga un mínimo de dos evidencias; O(c) tiempo y memoria.
  const minCitationsMet =
    citationsValid &&
    new Set(citedIds).size >= scenario.expectations.minCitations;
  const escalated = decision.origin === 'AI_ESCALATION';
  return {
    id: scenario.id,
    benign: scenario.expectations.benign,
    eligibleBenign: scenario.expectations.benign && engine.verdict === 'CLEAN',
    contextSha256: sha(toPromptSafeJson(scenario.context)),
    responseSha256: rawText ? sha(rawText) : null,
    schemaValid: parsed.success,
    citationsValid,
    minCitationsMet,
    valid,
    coherent:
      valid &&
      parsed.success &&
      scenario.expectations.acceptableOpinions.includes(parsed.data.opinion),
    noEscalationMet: !scenario.expectations.noEscalation || !escalated,
    escalated,
    status: !result.ok ? result.error.kind : validation.status,
    opinion: parsed.success ? parsed.data.opinion : null,
    citedIds,
    finalVerdict: decision.finalVerdict,
    policyRule: decision.rule,
    latencyMs,
    usage: meta.usage ?? null,
    model: meta.model ?? null,
  };
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Percentil por rango más próximo: ordenar cuesta O(n log n); no modifica la entrada. */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (p <= 0 || p > 1) throw new RangeError('Percentil fuera de rango.');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1] ?? null;
}

export function passed(row: EvalRow): boolean {
  return (
    row.valid &&
    row.schemaValid &&
    row.citationsValid &&
    row.minCitationsMet &&
    row.coherent &&
    row.noEscalationMet
  );
}

export async function evaluate(
  scenarios: readonly Scenario[],
  provider: AIProvider,
  onRow: (rows: readonly EvalRow[]) => Promise<void> = async () => {},
): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  // Un recorrido secuencial, una petición por escenario, sin reintentos de servicio.
  // ClaudeProvider también configura maxRetries=0 en el SDK.
  for (const scenario of scenarios) {
    const started = performance.now();
    let result: AIResult<AIAssessment>;
    try {
      result = await provider.generateStructured(
        buildAnalysisRequest(toPromptSafeJson(scenario.context)),
      );
    } catch {
      // Nunca copiar excepciones del transporte: podrían contener cabeceras o secretos.
      result = {
        ok: false,
        error: {
          kind: 'PROVIDER_DOWN',
          retryable: false,
          message: 'Fallo inesperado del proveedor.',
        },
      };
    }
    rows.push(judge(scenario, result, Math.round(performance.now() - started)));
    await onRow(rows);
  }
  return rows;
}

export async function fakeProvider(): Promise<FakeAIProvider> {
  // Respuestas fijas independientes de expectations: el modo fake verifica el evaluador,
  // no acredita calidad de Claude. Las pruebas adversariales alteran estas respuestas.
  const responses = JSON.parse(
    await readFile(
      new URL('../tests/ai-eval/fake-responses.json', import.meta.url),
      'utf8',
    ),
  ) as unknown[];
  const provider = new FakeAIProvider({ model: 'fake-eval' });
  for (const response of responses)
    provider.enqueueValue(aiAssessmentSchema.parse(response));
  return provider;
}

export function report(
  rows: readonly EvalRow[],
  total: number,
  fake: boolean,
  started: string,
): string {
  const count = (test: (row: EvalRow) => boolean) => rows.filter(test).length;
  const ratio = (n: number) =>
    `${n}/${total} (${total ? ((100 * n) / total).toFixed(1) : '0.0'} %)`;
  const complete = rows.length === total;
  const input = rows.reduce(
    (sum, row) => sum + (row.usage?.inputTokens ?? 0),
    0,
  );
  const output = rows.reduce(
    (sum, row) => sum + (row.usage?.outputTokens ?? 0),
    0,
  );
  const cost = fake
    ? 0
    : (input * PRICING.input + output * PRICING.output) / 1_000_000;
  const unknownUsage = count((row) => row.usage === null);
  const money = (n: number) => n.toFixed(6);
  const benign = rows.filter((row) => row.eligibleBenign);
  const yes = (value: boolean) => (value ? 'OK' : 'FALLA');
  return [
    '# T3.10 — Evaluación de IA',
    '',
    `Modo: **${fake ? 'FAKE — simulación sin red; no acredita evaluación real' : 'REAL — ClaudeProvider'}**.`,
    `Inicio UTC: ${started}. Actualización UTC: ${new Date().toISOString()}.`,
    `Modelo solicitado: ${fake ? 'fake-eval' : MODEL}. Prompt: ${PROMPT_VERSION}. RiskPolicy: ${POLICY_VERSION}.`,
    `Estado: **${complete ? (rows.every(passed) ? 'COMPLETA — CUMPLE' : 'COMPLETA — HAY INCUMPLIMIENTOS') : 'INCOMPLETA'}**. Intentos: ${rows.length}/${total}. Sin reintentos.`,
    '',
    '| Métrica | Resultado |',
    '|---|---|',
    `| Esquema válido | ${ratio(count((r) => r.schemaValid))} |`,
    `| Citas válidas | ${ratio(count((r) => r.citationsValid))} |`,
    `| Mínimo de citas distintas | ${ratio(count((r) => r.minCitationsMet))} |`,
    `| Validación completa | ${ratio(count((r) => r.valid))} |`,
    `| Coherencia (opinión aceptable predefinida) | ${ratio(count((r) => r.coherent))} |`,
    `| Escalamientos benignos CLEAN → SUSPICIOUS | ${benign.filter((r) => r.escalated).length}; ${benign.length} casos CLEAN benignos intentados, ${benign.filter((r) => r.valid).length} con respuesta válida |`,
    `| Expectativas cumplidas | ${ratio(count(passed))} |`,
    `| Latencia p50 / p95 (ms) | ${
      percentile(
        rows.map((r) => r.latencyMs),
        0.5,
      ) ?? 'N/D'
    } / ${
      percentile(
        rows.map((r) => r.latencyMs),
        0.95,
      ) ?? 'N/D'
    } |`,
    `| Tokens conocidos entrada / salida | ${input} / ${output} |`,
    `| Costo total estimado (USD) | ${money(cost)}${unknownUsage ? ' (parcial: faltan tokens)' : ''} |`,
    `| Costo estimado por intento (USD) | ${rows.length ? money(cost / rows.length) : 'N/D'} |`,
    `| Intentos sin información de tokens | ${unknownUsage} |`,
    '',
    'Las proporciones usan todos los escenarios previstos; los errores y pendientes no desaparecen del denominador. Citas válidas comprueba IDs en listas, correlaciones y prosa. Coherencia es coincidencia con opiniones aceptables fijadas antes de llamar, no una revisión humana del texto. Para esta muestra se exige cumplir todas las expectativas.',
    'Los benignos son etiquetas del corpus sintético, no garantías del antivirus. Una firma académica conserva DETECTED aunque el fixture sea inofensivo. Latencia: tiempo de cada llamada, incluidos fallos, percentiles por rango más próximo. En fake, tiempos y tokens no describen a Claude.',
    '',
    `Tarifa estándar Haiku 4.5 consultada ${PRICING.checked}: USD ${PRICING.input}/millón de tokens de entrada y USD ${PRICING.output}/millón de salida. [Fuente Anthropic](${PRICING.source}). Estimación sin impuestos, descuentos, caché ni batch; no es una factura.`,
    '',
    '| Caso | Estado | Opinión | Esquema | Citas | Mínimo | Coherencia | No escalar | Veredicto final | ms | Tokens entrada/salida |',
    '|---|---|---|---|---|---|---|---|---|---:|---|',
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.status} | ${r.opinion ?? 'N/D'} | ${yes(r.schemaValid)} | ${yes(r.citationsValid)} | ${yes(r.minCitationsMet)} | ${yes(r.coherent)} | ${yes(r.noEscalationMet)} | ${r.finalVerdict} | ${r.latencyMs} | ${r.usage ? `${r.usage.inputTokens}/${r.usage.outputTokens}` : 'N/D'} |`,
    ),
    '',
    '## Trazabilidad',
    '',
    'Solo se enviaron contextos sintéticos ai-context/v1 sin contenido de archivos; las expectativas y respuestas fake no se envían. Se guardan hashes y valores estructurados, sin credenciales ni texto libre de la respuesta.',
    '',
    ...rows.map(
      (r) =>
        `- ${r.id}: contexto SHA-256 \`${r.contextSha256}\`; respuesta SHA-256 \`${r.responseSha256 ?? 'N/D'}\`; regla ${r.policyRule}; citas ${r.citedIds.join(', ') || 'ninguna'}; modelo ${r.model === MODEL || r.model === 'fake-eval' ? r.model : 'no confirmado'}.`,
    ),
    '',
  ].join('\n');
}

function defaultOutput(fake: boolean): string {
  if (fake) return join(tmpdir(), `cybersoc-ai-eval-fake-${randomUUID()}.md`);
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'construccion'))) {
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(
        'Usa --output para indicar el reporte fuera del repositorio.',
      );
    directory = parent;
  }
  return join(
    directory,
    'construccion/sprints/sprint-03-motor-hibrido-ia-v2/evidencias/08-ai-eval.md',
  );
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let fake = false;
  let output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fake') fake = true;
    else if (
      args[i] === '--output' &&
      args[i + 1] &&
      !args[i + 1]!.startsWith('--')
    )
      output = resolve(args[++i]!);
    else throw new Error('Uso: npm run ai:eval -- [--fake] [--output ruta.md]');
  }
  if (!fake && process.env.CI) throw new Error('CI solo permite --fake.');
  const key = process.env.CYBERSOC_ANTHROPIC_API_KEY?.trim();
  if (!fake && !key)
    throw new Error(
      'Falta CYBERSOC_ANTHROPIC_API_KEY. No se hizo ninguna llamada.',
    );
  const scenarios = await loadScenarios();
  const provider = fake
    ? await fakeProvider()
    : new ClaudeProvider({ apiKey: key!, model: MODEL });
  const destination = output ?? defaultOutput(fake);
  if (fake && /(?:^|[\\/])08-ai-eval\.md$/i.test(destination))
    throw new Error(
      'El reporte 08-ai-eval.md se reserva a la evaluación real.',
    );
  await mkdir(dirname(destination), { recursive: true });
  // wx impide sobrescribir o repetir accidentalmente la evaluación de pago.
  const file = await open(destination, 'wx');
  const started = new Date().toISOString();
  const save = async (rows: readonly EvalRow[]) => {
    const bytes = Buffer.from(
      report(rows, scenarios.length, fake, started),
      'utf8',
    );
    let offset = 0;
    while (offset < bytes.length)
      offset += (await file.write(bytes, offset, bytes.length - offset, offset))
        .bytesWritten;
    await file.truncate(bytes.length);
    await file.sync();
  };
  try {
    await save([]);
    const rows = await evaluate(scenarios, provider, async (rows) => {
      await save(rows);
      const last = rows.at(-1)!;
      console.log(
        `ai:eval ${rows.length}/${scenarios.length}: ${last.id} ${last.status} ${passed(last) ? 'OK' : 'FALLA'}`,
      );
    });
    console.log(`ai:eval: reporte guardado (${fake ? 'FAKE' : 'REAL'}).`);
    return rows.every(passed) ? 0 : 1;
  } finally {
    await file.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    // Mensajes propios y controlados; nunca mostrar stack, cabeceras ni mensajes del SDK.
    const known =
      error instanceof Error &&
      /^(Uso:|CI solo|Falta CYBERSOC_|El reporte 08|Usa --output|No hay escenarios|Escenario inválido|ID de escenario)/.test(
        error.message,
      );
    console.error(
      known
        ? error.message
        : 'ai:eval: no se pudo completar. Comprueba escenarios y destino; no se sobrescriben reportes existentes.',
    );
    process.exitCode = 2;
  }
}
