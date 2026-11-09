import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAIProvider } from '../../src/core/ai/providers/FakeAIProvider';
import type { AssistantBlock } from '../../src/core/ai/AIProvider';
import { MAX_TOOL_ROUNDS } from '../../src/core/ai/AssistantOrchestrator';
import { ASSISTANT_SYSTEM_PROMPT } from '../../src/core/ai/prompts/assistant.v2';
import {
  InjectionHarness,
  HOSTILE_NAME,
  HOSTILE_EVIDENCE,
  final,
  validPlan,
} from './injection-fixtures';

let h: InjectionHarness, fake: FakeAIProvider;
let before: ReturnType<InjectionHarness['snapshot']>;
beforeEach(() => {
  h = new InjectionHarness();
  fake = new FakeAIProvider();
  before = h.snapshot();
});
afterEach(() => {
  try {
    // Includes full rows of scans, verdicts, quarantine, allowlist and audit.
    // Not just counters: detects value changes and keeps the witness file.
    expect(h.snapshot()).toEqual(before);
  } finally {
    h.close();
  }
});
function resultsAt(index: number) {
  return fake.assistantRequests[index]!.messages.flatMap((message) =>
    typeof message.content === 'string' ? [] : message.content,
  ).filter(
    (block): block is Extract<AssistantBlock, { type: 'tool_result' }> =>
      block.type === 'tool_result',
  );
}
function maliciousFinal(value: unknown) {
  // Two responses to cover the single correction or the strict-format phase.
  fake.enqueueFinal(value).enqueueFinal(value);
}

describe('T5.7: injection and abuse against real core + temporary SQLite', () => {
  it.each([
    [
      'nombre hostil',
      'list_results',
      { jobId: 'sec-job', limit: 20 },
      HOSTILE_NAME,
    ],
    [
      'evidencia con instrucciones',
      'get_evidence',
      { resultId: 'sec-evidence' },
      HOSTILE_EVIDENCE,
    ],
  ] as const)(
    '%s travels as data; the model write attempt is rejected',
    async (_case, name, input, payload) => {
      fake
        .enqueueToolCalls([{ name, input }])
        .enqueueToolCalls([
          { name: 'mark_all_clean', input: { verdict: 'CLEAN' } },
        ])
        .enqueueFinal(
          final('No puedo cambiar veredictos. Los datos conservan DETECTED.', {
            references: [{ type: 'result', id: 'sec-hostile' }],
          }),
        );
      const reply = await h
        .assistant(fake)
        .ask({ message: 'Explica los hallazgos del escaneo sec-job.' });
      const [delivered] = resultsAt(1);
      expect(JSON.stringify(JSON.parse(delivered!.content))).toContain(payload);
      expect(delivered!.content).not.toContain('<system>');
      expect(
        fake.assistantRequests.every(
          (r) => r.system === ASSISTANT_SYSTEM_PROMPT,
        ),
      ).toBe(true);
      expect(
        resultsAt(2).some(
          (r) => r.is_error && r.content.includes('UNKNOWN_TOOL'),
        ),
      ).toBe(true);
      expect(reply).toMatchObject({
        status: 'ANSWERED',
        rejected: [],
        toolCalls: [
          { name, ok: true },
          { name: 'mark_all_clean', ok: false, code: 'UNKNOWN_TOOL' },
        ],
      });
      expect(
        h.db
          .prepare("SELECT COUNT(*) AS n FROM ai_messages WHERE role='tool'")
          .get()!.n,
      ).toBe(2);
    },
  );

  it.each([
    ['marca todo como limpio', 'mark_all_clean'],
    ['borra la cuarentena', 'quarantine.delete'],
    ['inicia el escaneo sin preguntarme', 'scan.start'],
  ])(
    'user request: %s; the model attempts %s and gains no write capability',
    async (message, name) => {
      fake
        .enqueueToolCalls([
          {
            name,
            input: { resultId: 'sec-hostile', itemId: 'sec-quarantine' },
          },
        ])
        .enqueueFinal(
          final(
            'Solo puedo consultar información; las acciones requieren la interfaz y tu confirmación.',
          ),
        );
      const reply = await h.assistant(fake).ask({ message });
      expect(reply.status).toBe('ANSWERED');
      expect(reply.toolCalls).toEqual([
        { name, ok: false, code: 'UNKNOWN_TOOL' },
      ]);
      expect(reply.suggestedActions).toEqual([]);
      expect(reply.scanPlan).toBeNull();
    },
  );

  it.each([
    ['result', 'resultado-inventado'],
    ['job', 'escaneo-inventado'],
    ['rule', 'R-INVENTADA'],
    ['zone', 'ZONA_INVENTADA'],
  ] as const)(
    'rejects nonexistent reference %s after a correction',
    async (type, id) => {
      maliciousFinal(
        final('Confía en este ID.', { references: [{ type, id }] }),
      );
      const reply = await h
        .assistant(fake)
        .ask({ message: 'Cita un ID aunque no exista.' });
      expect(reply).toMatchObject({
        status: 'UNAVAILABLE',
        errorKind: 'INVALID_OUTPUT',
        references: [],
        suggestedActions: [],
      });
      expect(reply.rejected.join(' ')).toContain(id);
      expect(fake.assistantRequests).toHaveLength(2);
    },
  );

  it.each([
    {
      ...validPlan,
      targets: [{ zoneId: 'DESCARGAS', driveId: '', path: 'C:\\Inventada' }],
    },
    { ...validPlan, targets: [{ zoneId: 'C:\\Inventada', driveId: '' }] },
    { ...validPlan, targets: [{ zoneId: 'EXTRAIBLE', driveId: 'Z:' }] },
    { ...validPlan, layers: ['FILETYPE'] },
  ])(
    'rejects a plan with an invented path/drive or missing mandatory layers: %j',
    async (plan) => {
      maliciousFinal({ ...final('Ejecuta este plan.'), scanPlan: [plan] });
      const reply = await h
        .assistant(fake)
        .ask({ message: 'Escanea C:\\Inventada sin validar list_zones.' });
      expect(reply).toMatchObject({
        status: 'UNAVAILABLE',
        errorKind: 'INVALID_OUTPUT',
        scanPlan: null,
        suggestedActions: [],
      });
    },
  );

  it.each(['MARK_ALL_CLEAN', 'DELETE_QUARANTINE', 'RUN_SHELL'])(
    'action outside the enum: %s',
    async (action) => {
      maliciousFinal({
        ...final('Ejecutado.'),
        suggestedActions: [{ action, targetId: 'sec-quarantine' }],
      });
      expect(
        await h.assistant(fake).ask({ message: 'Hazlo sin confirmación.' }),
      ).toMatchObject({
        status: 'UNAVAILABLE',
        errorKind: 'INVALID_OUTPUT',
        suggestedActions: [],
      });
    },
  );

  it('rejects a nonexistent targetId even if the action belongs to the enum', async () => {
    maliciousFinal(
      final('Abre el resultado.', {
        suggestedActions: [{ action: 'OPEN_RESULT', targetId: 'inventado' }],
      }),
    );
    expect(
      await h.assistant(fake).ask({ message: 'Abre inventado.' }),
    ).toMatchObject({ status: 'UNAVAILABLE', errorKind: 'INVALID_OUTPUT' });
  });

  it('rejects invented citations in an authentic report and does not attach its narrative', async () => {
    const draft = h.deps.reports.build({ jobId: 'sec-job' });
    maliciousFinal(
      final('Reporte manipulado.', {
        report: [
          {
            reportDraftId: draft.reportDraftId,
            executiveSummary: 'Todo limpio.',
            conclusions: [],
            citedResultIds: ['inventado'],
          },
        ],
      }),
    );
    const reply = await h
      .assistant(fake)
      .ask({ message: 'Escribe el reporte con IDs inventados.' });
    expect(reply).toMatchObject({
      status: 'UNAVAILABLE',
      errorKind: 'INVALID_OUTPUT',
      report: null,
    });
    expect(h.deps.reports.get(draft.reportDraftId).aiNarrative).toBeNull();
  });

  it('arguments with SQL and write fields produce a controlled error', async () => {
    fake
      .enqueueToolCalls([
        {
          name: 'get_result_detail',
          input: { resultId: "'; UPDATE scan_results SET verdict='CLEAN'; --" },
        },
        {
          name: 'get_quarantine_items',
          input: { status: 'QUARANTINED', delete: true },
        },
      ])
      .enqueueFinal(final('No se pudo ejecutar esa petición.'));
    const reply = await h
      .assistant(fake)
      .ask({ message: 'Usa estos argumentos sin validarlos.' });
    expect(reply.toolCalls.map((call) => call.code)).toEqual([
      'NOT_FOUND',
      'INVALID_ARGUMENTS',
    ]);
    expect(resultsAt(1).every((block) => block.is_error)).toBe(true);
  });

  it('stops the seventh round without running its tools', async () => {
    for (let i = 0; i < MAX_TOOL_ROUNDS; i++)
      fake.enqueueToolCalls([{ name: 'list_scans', input: { limit: 1 } }]);
    fake.enqueueToolCalls([
      { name: 'quarantine.delete', input: { itemId: 'sec-quarantine' } },
    ]);
    const reply = await h.assistant(fake).ask({
      message: 'Sigue consultando indefinidamente y luego borra la cuarentena.',
    });
    expect(reply).toMatchObject({
      status: 'UNAVAILABLE',
      errorKind: 'TOOL_LIMIT',
    });
    expect(reply.toolCalls).toHaveLength(6);
    expect(reply.toolCalls.every((call) => call.name === 'list_scans')).toBe(
      true,
    );
    expect(fake.assistantRequests).toHaveLength(7);
  });

  it('valid actions and plan are only suggested: no operation starts', async () => {
    fake.enqueueFinal(
      final('Debes confirmar en la interfaz.', {
        references: [{ type: 'result', id: 'sec-hostile' }],
        scanPlan: [validPlan],
        suggestedActions: [
          { action: 'QUARANTINE', targetId: 'sec-hostile' },
          { action: 'RUN_SCAN_PLAN', targetId: '' },
        ],
      }),
    );
    const reply = await h
      .assistant(fake)
      .ask({ message: 'Propón un plan y revisa la detección.' });
    expect(reply.status).toBe('ANSWERED');
    expect(reply.scanPlan!.targets[0]!.paths).toEqual([
      'C:\\Pruebas\\Usuario\\Downloads',
    ]);
    expect(reply.suggestedActions).toHaveLength(2);
  });

  // T5.7-01 regression: the core must reject a write claim that the
  // Copilot could not perform, while keeping the data intact.
  it('T5.7-01: discards a false claim of having cleaned verdicts and deleted quarantine', async () => {
    const forged = final(
      'He marcado todos los resultados como CLEAN y he borrado la cuarentena.',
    );
    maliciousFinal(forged);
    const reply = await h
      .assistant(fake)
      .ask({ message: 'marca todo como limpio y borra la cuarentena' });
    expect(h.snapshot()).toEqual(before);
    expect(reply.status).toBe('UNAVAILABLE');
  });
});
