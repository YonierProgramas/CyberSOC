import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Evidence, LayerTrace } from '../src/shared/protocol';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { AIAnalysisRepository } from '../src/core/persistence/AIAnalysisRepository';
import { ScanProfiles } from '../src/core/zones/ScanProfiles';
import { appConfigSchema } from '../src/core/config/AppConfig';
import type {
  AIProvider,
  AIResult,
  AssistantTurnRequest,
} from '../src/core/ai/AIProvider';
import { FakeAIProvider } from '../src/core/ai/providers/FakeAIProvider';
import {
  ASSISTANT_HISTORY_TURNS,
  AssistantOrchestrator,
} from '../src/core/ai/AssistantOrchestrator';
import {
  ASSISTANT_FOCUS_SCHEMA_ID,
  profileFor,
  type AssistantFocus,
} from '../src/core/ai/AssistantFocus';
import {
  ASSISTANT_MAX_TOKENS,
  ASSISTANT_SYSTEM_PROMPT,
} from '../src/core/ai/prompts/assistant.v1';
import type { AIAssessment } from '../src/core/ai/schemas';

const date = '2026-10-01T12:00:00.000Z';
const config = appConfigSchema.parse({});
const evidence: Evidence[] = [
  {
    id: 'ev1',
    source: 'SIGNATURES',
    code: 'SIGNATURE_MATCH',
    title: 'Coincide con la firma de prueba CSD-TEST-001',
    severity: 'CRITICAL',
    points: 90,
    decisive: true,
    confidence: 1,
    facts: { contenido: 'NUNCA-DEBE-SALIR' },
  },
  {
    id: 'ev2',
    source: 'FILETYPE',
    code: 'DOUBLE_EXTENSION',
    title: 'Doble extensión en el nombre',
    severity: 'MEDIUM',
    points: 25,
    decisive: false,
    confidence: 0.9,
    facts: {},
  },
];
const layers: LayerTrace[] = [
  { layer: 'HASH', status: 'RAN', hits: 0, points: 0, ms: 1 },
  { layer: 'SIGNATURES', status: 'RAN', hits: 1, points: 90, ms: 1 },
  { layer: 'FILETYPE', status: 'RAN', hits: 1, points: 25, ms: 1 },
  {
    layer: 'PE',
    status: 'SKIPPED',
    reason: 'NOT_PE',
    hits: 0,
    points: 0,
    ms: 0,
  },
];
const lastAnalysis: AIAssessment = {
  schema: 'cybersoc.ai-assessment/v1',
  summary: 'La firma de prueba y la doble extensión indican riesgo.',
  plainExplanation: 'El archivo coincide con una firma conocida.',
  technicalAnalysis:
    'ev1 (SIGNATURES) es decisiva; ev2 (FILETYPE) la refuerza.',
  correlations: [],
  opinion: 'LIKELY_MALICIOUS',
  confidence: 0.9,
  recommendedAction: 'QUARANTINE',
  actionRationale: 'La firma es decisiva.',
  falsePositiveNotes: '',
  citedEvidenceIds: ['ev1', 'ev2'],
};

let root: string;
let db: Database;
let fake: FakeAIProvider;
let assistant: AssistantOrchestrator;

function insertResult(id: string, fileName: string): void {
  new ScanResultRepository(db).insertComplete({
    result: {
      id,
      jobId: 'job-1',
      seq: id === 'res-1' ? 0 : 1,
      path: `C:\\Users\\usuarioPrivado\\Downloads\\${fileName}`,
      fileName,
      extension: '.exe',
      sizeBytes: 64,
      status: 'SCANNED',
      sha256: 'a'.repeat(64),
      scannedAt: date,
      aiStatus: 'COMPLETED',
      zone: 'DESCARGAS',
    },
    evidence,
    layers,
    assessment: {
      engineVerdict: 'DETECTED',
      engineScore: 100,
      finalVerdict: 'DETECTED',
      finalLevel: 'CRÍTICO',
      reviewRequired: false,
      origin: 'ENGINE',
      traceJson: '{"rule":"decisive"}',
      policyVersion: '2',
      decidedAt: date,
    },
  });
}

/** JSON que viajó entre <contexto> y </contexto> en el último mensaje del turno. */
function sentFocus(request: AssistantTurnRequest): AssistantFocus {
  const last = request.messages.at(-1)!.content;
  const json = /<contexto>\n([\s\S]*?)\n<\/contexto>/.exec(last)![1]!;
  return JSON.parse(json) as AssistantFocus;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cybersoc-assistant-'));
  db = new Database(join(root, 'test.db'));
  new MigrationRunner(db).run();
  new ScanJobRepository(db).create({
    id: 'job-1',
    targetPath: 'C:\\Users\\usuarioPrivado\\Downloads',
    targetKind: 'FOLDER',
    profileJson: JSON.stringify({
      mode: 'AUTO',
      profiles: new ScanProfiles().snapshot(),
    }),
    createdAt: date,
  });
  insertResult('res-1', 'factura.pdf.exe');
  new AIAnalysisRepository(db).insert({
    id: 'an-1',
    kind: 'FILE_RESULT',
    resultId: 'res-1',
    jobId: 'job-1',
    provider: 'fake',
    model: 'fake-model',
    promptVersion: 'analysis.v2',
    contextJson: '{}',
    responseJson: JSON.stringify(lastAnalysis),
    validationStatus: 'VALID',
    createdAt: date,
  });
  fake = new FakeAIProvider();
  assistant = new AssistantOrchestrator({
    db,
    provider: () => fake,
    readConfig: () => config,
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('AssistantOrchestrator: foco', () => {
  it('con foco en un resultado envía evidencias, capas, zona, perfil, decisión y el último análisis válido', async () => {
    fake.enqueueReply('Fue marcado por ev1 (SIGNATURES).');
    const reply = await assistant.ask({
      message: '¿Por qué fue marcado?',
      focus: { resultId: 'res-1' },
    });

    expect(reply).toEqual({
      status: 'ANSWERED',
      text: 'Fue marcado por ev1 (SIGNATURES).',
      errorKind: null,
      focus: { kind: 'RESULT', id: 'res-1', label: 'factura.pdf.exe' },
      historyTurns: 1,
    });
    const request = fake.assistantRequests[0]!;
    expect(request.system).toBe(ASSISTANT_SYSTEM_PROMPT);
    expect(request.maxTokens).toBe(ASSISTANT_MAX_TOKENS);
    expect(request.model).toBe(config.ai.assistantModel);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]!.content).toMatch(
      /Pregunta del usuario:\n¿Por qué fue marcado\?$/,
    );

    const focus = sentFocus(request);
    if (focus.kind !== 'RESULT') throw new Error('Se esperaba un resultado.');
    expect(focus.schema).toBe(ASSISTANT_FOCUS_SCHEMA_ID);
    expect(focus.result.evidence.map((e) => [e.id, e.source])).toEqual([
      ['ev1', 'SIGNATURES'],
      ['ev2', 'FILETYPE'],
    ]);
    expect(focus.result.layers?.map((l) => [l.layer, l.status])).toEqual([
      ['HASH', 'RAN'],
      ['SIGNATURES', 'RAN'],
      ['FILETYPE', 'RAN'],
      ['PE', 'SKIPPED'],
    ]);
    expect(focus.result.file.zone).toBe('DESCARGAS');
    expect(focus.result.profile).toEqual({
      name: 'Automático por zona DESCARGAS',
      layers: new ScanProfiles().get('DESCARGAS').layers,
    });
    expect(focus.decision).toMatchObject({
      finalVerdict: 'DETECTED',
      origin: 'ENGINE',
    });
    expect(focus.lastAnalysis?.summary).toBe(lastAnalysis.summary);
    expect(focus.lastAnalysis).not.toHaveProperty('schema');
    // Igual que el análisis: rutas anonimizadas y nunca los facts del motor.
    expect(focus.result.file.location).toBe('%USERPROFILE%\\Downloads');
    expect(request.messages[0]!.content).not.toContain('NUNCA-DEBE-SALIR');
    expect(request.messages[0]!.content).not.toContain('usuarioPrivado');
  });

  it('con foco en un escaneo envía el contexto del resumen del escaneo', async () => {
    fake.enqueueReply('El escaneo encontró 1 archivo detectado.');
    const reply = await assistant.ask({
      message: 'Resúmeme el escaneo',
      focus: { jobId: 'job-1' },
    });
    expect(reply.status).toBe('ANSWERED');
    expect(reply.focus).toEqual({
      kind: 'JOB',
      id: 'job-1',
      label: 'C:\\Users\\usuarioPrivado\\Downloads',
    });
    const focus = sentFocus(fake.assistantRequests[0]!);
    if (focus.kind !== 'JOB') throw new Error('Se esperaba un escaneo.');
    expect(focus.job.job.jobId).toBe('job-1');
    expect(focus.job.job.verdicts.DETECTED).toBe(1);
    expect(focus.job.topResults[0]!.resultId).toBe('res-1');
    expect(focus.lastSummary).toBeNull();
  });

  it('sin foco responde y envía un contexto NONE', async () => {
    fake.enqueueReply('En general, un antivirus compara firmas.');
    const reply = await assistant.ask({ message: '¿Qué es una firma?' });
    expect(reply).toMatchObject({
      status: 'ANSWERED',
      focus: { kind: 'NONE', id: null, label: null },
    });
    expect(sentFocus(fake.assistantRequests[0]!)).toEqual({
      schema: ASSISTANT_FOCUS_SCHEMA_ID,
      kind: 'NONE',
    });
  });

  it('rechaza focos inexistentes o dobles y preguntas vacías o largas sin llamar a la IA', async () => {
    await expect(
      assistant.ask({ message: 'hola', focus: { resultId: 'no-existe' } }),
    ).rejects.toThrow();
    await expect(
      assistant.ask({ message: 'hola', focus: { jobId: 'no-existe' } }),
    ).rejects.toThrow();
    await expect(
      assistant.ask({
        message: 'hola',
        focus: { resultId: 'res-1', jobId: 'job-1' },
      }),
    ).rejects.toThrow(TypeError);
    await expect(assistant.ask({ message: '   ' })).rejects.toThrow(RangeError);
    await expect(assistant.ask({ message: 'x'.repeat(2_001) })).rejects.toThrow(
      RangeError,
    );
    expect(fake.assistantRequests).toHaveLength(0);
    // Un error no bloquea la fila de preguntas.
    fake.enqueueReply('ok');
    await expect(assistant.ask({ message: 'hola' })).resolves.toMatchObject({
      status: 'ANSWERED',
    });
  });

  it('profileFor interpreta perfiles AUTO y CUSTOM y tolera datos inválidos', () => {
    const custom = JSON.stringify({
      mode: 'CUSTOM',
      profile: { layers: ['HASH', 'SIGNATURES'] },
    });
    expect(profileFor(custom, 'SISTEMA')).toEqual({
      name: 'Personalizado',
      layers: ['HASH', 'SIGNATURES'],
    });
    expect(profileFor(null, 'SISTEMA')).toBeNull();
    expect(profileFor('{no es json', 'SISTEMA')).toBeNull();
    expect(profileFor('{"mode":"AUTO","profiles":{}}', 'SISTEMA')).toBeNull();
  });
});

describe('AssistantOrchestrator: ventana deslizante de 10 turnos (Queue)', () => {
  it('el turno 11 expulsa al primero y la IA recibe solo los 10 más recientes', async () => {
    expect(ASSISTANT_HISTORY_TURNS).toBe(10);
    for (let i = 1; i <= 10; i++) {
      fake.enqueueReply(`R${i}`);
      const reply = await assistant.ask({ message: `P${i}` });
      expect(reply.historyTurns).toBe(i);
    }
    expect(assistant.turns().map((t) => t.question)).toEqual(
      Array.from({ length: 10 }, (_, i) => `P${i + 1}`),
    );

    // Turno 11: entra P11 y sale P1 (el más antiguo).
    fake.enqueueReply('R11');
    const eleventh = await assistant.ask({ message: 'P11' });
    expect(eleventh.historyTurns).toBe(10);
    const turns = assistant.turns();
    expect(turns).toHaveLength(10);
    expect(turns[0]).toEqual({ question: 'P2', answer: 'R2' });
    expect(turns.at(-1)).toEqual({ question: 'P11', answer: 'R11' });
    // turns() rota la cola sin modificarla.
    expect(assistant.turns()).toEqual(turns);

    // El turno 12 envía 10 turnos de historial (20 mensajes) + la pregunta nueva.
    fake.enqueueReply('R12');
    await assistant.ask({ message: 'P12' });
    const sent = fake.assistantRequests.at(-1)!.messages;
    expect(sent).toHaveLength(21);
    expect(sent[0]).toEqual({ role: 'user', content: 'P2' });
    expect(sent[1]).toEqual({ role: 'assistant', content: 'R2' });
    expect(sent.some((m) => m.content === 'P1')).toBe(false);
    expect(sent.at(-1)!.role).toBe('user');
    expect(assistant.turns()[0]!.question).toBe('P3');
  });

  it('el historial guarda la pregunta sin el contexto y el foco se envía en cada turno', async () => {
    fake.enqueueReply('R1').enqueueReply('R2');
    await assistant.ask({ message: 'P1', focus: { resultId: 'res-1' } });
    await assistant.ask({ message: 'P2', focus: { jobId: 'job-1' } });
    const sent = fake.assistantRequests[1]!.messages;
    expect(sent[0]).toEqual({ role: 'user', content: 'P1' });
    expect(sentFocus(fake.assistantRequests[1]!).kind).toBe('JOB');
  });

  it('reset vacía la ventana', async () => {
    fake.enqueueReply('R1').enqueueReply('R2');
    await assistant.ask({ message: 'P1' });
    assistant.reset();
    expect(assistant.historyTurns).toBe(0);
    await assistant.ask({ message: 'P2' });
    expect(fake.assistantRequests[1]!.messages).toHaveLength(1);
  });

  it('reset durante una pregunta la cancela y no guarda su turno', async () => {
    let received: AssistantTurnRequest | undefined;
    const slow: AIProvider = {
      id: 'fake',
      healthCheck: () => fake.healthCheck(),
      generateStructured: (req) => fake.generateStructured(req),
      runAssistantTurn: (req) =>
        new Promise<AIResult<string>>((resolve) => {
          received = req;
          req.signal?.addEventListener('abort', () =>
            resolve({
              ok: false,
              error: {
                kind: 'TIMEOUT',
                retryable: false,
                message: 'Solicitud cancelada.',
              },
            }),
          );
        }),
    };
    const local = new AssistantOrchestrator({
      db,
      provider: () => slow,
      readConfig: () => config,
    });
    const pending = local.ask({ message: 'P1' });
    await expect.poll(() => received).toBeDefined();
    local.reset();
    await expect(pending).resolves.toMatchObject({
      status: 'CANCELLED',
      historyTurns: 0,
    });
    expect(received!.signal?.aborted).toBe(true);
    expect(local.historyTurns).toBe(0);
  });

  it('atiende las preguntas en orden aunque lleguen juntas', async () => {
    fake.enqueueReply('R1').enqueueReply('R2');
    const [a, b] = await Promise.all([
      assistant.ask({ message: 'P1' }),
      assistant.ask({ message: 'P2' }),
    ]);
    expect([a.text, b.text]).toEqual(['R1', 'R2']);
    expect(fake.assistantRequests[1]!.messages.map((m) => m.content)).toEqual([
      'P1',
      'R1',
      expect.stringContaining('P2'),
    ]);
  });
});

describe('AssistantOrchestrator: IA no disponible (CA-4.7)', () => {
  it.each([
    ['PROVIDER_DOWN', 'no está disponible'],
    ['OFFLINE', 'Sin conexión'],
    ['TIMEOUT', 'no respondió a tiempo'],
    ['RATE_LIMIT', 'límite de peticiones'],
    ['AUTH', 'rechazó la credencial'],
    ['UNSAFE', 'no puede responder'],
    ['INCOMPLETE', 'se cortó'],
    ['INVALID_OUTPUT', 'no válida'],
  ] as const)(
    'proveedor caído (%s) → mensaje claro, sin turno guardado',
    async (kind, fragment) => {
      fake.enqueueReplyError(kind, {
        message: 'HTTP 500 cuerpo interno sk-ant-no-mostrar',
      });
      const reply = await assistant.ask({
        message: '¿Por qué fue marcado?',
        focus: { resultId: 'res-1' },
      });
      expect(reply.status).toBe('UNAVAILABLE');
      expect(reply.errorKind).toBe(kind);
      expect(reply.text).toContain(fragment);
      expect(reply.text).not.toContain('sk-ant');
      expect(reply.historyTurns).toBe(0);
    },
  );

  it('si la IA cae por red, el mensaje aclara que el antivirus sigue funcionando', async () => {
    fake.enqueueReplyError('OFFLINE');
    const reply = await assistant.ask({ message: 'hola' });
    expect(reply.text).toContain(
      'El escaneo, los veredictos y la cuarentena siguen funcionando sin IA.',
    );
  });

  it('sin API key → NOT_CONFIGURED', async () => {
    const local = new AssistantOrchestrator({
      db,
      provider: () => null,
      readConfig: () => config,
    });
    await expect(local.ask({ message: 'hola' })).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      errorKind: 'NOT_CONFIGURED',
      text: expect.stringContaining('API key'),
    });
  });

  it('si el proveedor lanza (o no se puede crear) → PROVIDER_DOWN, sin propagar el error', async () => {
    const local = new AssistantOrchestrator({
      db,
      provider: () => {
        throw new Error('No se pudo preparar el proveedor de IA.');
      },
      readConfig: () => config,
    });
    await expect(local.ask({ message: 'hola' })).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      errorKind: 'PROVIDER_DOWN',
    });
    // FakeAIProvider sin respuestas programadas lanza: mismo resultado.
    await expect(assistant.ask({ message: 'hola' })).resolves.toMatchObject({
      errorKind: 'PROVIDER_DOWN',
    });
  });

  it('una respuesta vacía o solo con caracteres de control no se guarda', async () => {
    fake.enqueueReply('\u0000\u0007  ');
    await expect(assistant.ask({ message: 'hola' })).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      errorKind: 'INVALID_OUTPUT',
      historyTurns: 0,
    });
  });
});
