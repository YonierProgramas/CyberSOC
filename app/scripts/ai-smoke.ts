// Smoke test de la API de Claude (CA-0.8). Usa la red y consume tokens: no forma parte de las pruebas.
// Uso: CYBERSOC_ANTHROPIC_API_KEY=... npm run ai:smoke
import { z } from 'zod';
import { ClaudeProvider } from '../src/core/ai/providers/ClaudeProvider.ts';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const apiKey = process.env.CYBERSOC_ANTHROPIC_API_KEY?.trim() ?? '';
const model = process.env.CYBERSOC_ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;

// Defensa adicional: la clave nunca debe aparecer en la salida.
function print(line: string): void {
  console.log(apiKey ? line.split(apiKey).join('[REDACTADO]') : line);
}

if (!apiKey) {
  print('ai:smoke: falta la variable de entorno CYBERSOC_ANTHROPIC_API_KEY.');
  process.exit(2);
}

const provider = new ClaudeProvider({ apiKey, model });
print(`Proveedor: ${provider.id} · modelo solicitado: ${model}`);

const health = await provider.healthCheck();
if (!health.ok) {
  print(
    `healthCheck: ERROR ${health.error.kind} (reintentable: ${health.error.retryable}) — ${health.error.message}`,
  );
  process.exit(1);
}
print(
  `healthCheck: ok · modelo: ${health.value.model} · latencia: ${health.latencyMs} ms`,
);

const SmokeSchema = z.strictObject({
  status: z.literal('ok'),
  model: z.string(),
});
const result = await provider.generateStructured({
  system: 'Eres una prueba de conectividad. Responde solo con el JSON pedido.',
  prompt:
    'Devuelve status "ok" y en "model" el identificador del modelo que eres.',
  schema: SmokeSchema,
  maxTokens: 256,
});

if (!result.ok) {
  const retry =
    result.error.retryAfterMs !== undefined
      ? ` · reintentar en ${result.error.retryAfterMs} ms`
      : '';
  print(
    `generateStructured: ERROR ${result.error.kind} (reintentable: ${result.error.retryable}${retry}) — ${result.error.message}`,
  );
  process.exit(1);
}

print('generateStructured: ok (salida validada con zod)');
print(`  salida:   ${JSON.stringify(result.value)}`);
print(`  modelo:   ${result.model}`);
print(
  `  tokens:   entrada ${result.usage.inputTokens} · salida ${result.usage.outputTokens}`,
);
print(`  latencia: ${result.latencyMs} ms`);
