import { afterEach, beforeEach, expect, it } from 'vitest';
import { hasUnsupportedActionClaim } from '../../src/core/ai/AssistantActionClaims';
import { FakeAIProvider } from '../../src/core/ai/providers/FakeAIProvider';
import { InjectionHarness, final, validPlan } from './injection-fixtures';

it.each([
  'He marcado todos los resultados como CLEAN y he borrado la cuarentena.',
  'Ya borré la cuarentena.',
  'Eliminé el archivo.',
  'He iniciado el escaneo.',
  'Acabo de restaurar el archivo.',
  'Hemos movido los archivos a cuarentena.',
  'No puedo hacerlo, pero ya eliminé el archivo.',
  'No solo he borrado la cuarentena.',
  'No consulté nada; he cambiado el veredicto.',
  'Ya lo borré.',
  'He **eliminado** el archivo.',
  'He bor\u200brado la cuarentena.',
])('rechaza afirmación de operación sin recibo: %s', (text) => {
  expect(hasUnsupportedActionClaim(text)).toBe(true);
});
it.each([
  'No he borrado la cuarentena.',
  'Nunca he cambiado los veredictos.',
  'No borré el archivo.',
  'No he iniciado ningún escaneo.',
  'No puedo borrar archivos. Confirma la acción en la interfaz.',
  'El resultado fue puesto en cuarentena por el usuario según el historial.',
  'He consultado las evidencias del archivo.',
  'He encontrado dos resultados.',
  'El motor detectó este archivo; yo no cambio veredictos.',
])('conserva negativas y explicaciones: %s', (text) => {
  expect(hasUnsupportedActionClaim(text)).toBe(false);
});

let h: InjectionHarness;
beforeEach(() => {
  h = new InjectionHarness();
});
afterEach(() => h.close());

it('pide una corrección y publica solo la respuesta corregida; conserva estado', async () => {
  const before = h.snapshot();
  const fake = new FakeAIProvider()
    .enqueueFinal(final('He borrado la cuarentena.'))
    .enqueueFinal(final('No puedo borrar; debes confirmar en la interfaz.'));
  const reply = await h.assistant(fake).ask({ message: 'Borra todo.' });
  expect(reply.status).toBe('ANSWERED');
  expect(reply.text).toBe('No puedo borrar; debes confirmar en la interfaz.');
  expect(fake.assistantRequests).toHaveLength(2);
  expect(
    h.db
      .prepare("SELECT content FROM ai_messages WHERE role='assistant'")
      .all(),
  ).toEqual([{ content: reply.text }]);
  expect(h.snapshot()).toEqual(before);
});
it.each(['report', 'scanPlan'] as const)(
  'rechaza también afirmaciones en %s',
  async (field) => {
    const draft = h.deps.reports.build();
    const wire = final(
      'Consulta los detalles.',
      field === 'report'
        ? {
            report: [
              {
                reportDraftId: draft.reportDraftId,
                executiveSummary: 'He cambiado los veredictos.',
                conclusions: [],
                citedResultIds: [],
              },
            ],
          }
        : {
            scanPlan: [{ ...validPlan, rationale: 'He iniciado el escaneo.' }],
          },
    );
    const fake = new FakeAIProvider().enqueueFinal(wire).enqueueFinal(wire);
    const before = h.snapshot();
    const reply = await h.assistant(fake).ask({ message: 'Hazlo.' });
    expect(reply.status).toBe('UNAVAILABLE');
    expect(reply.errorKind).toBe('INVALID_OUTPUT');
    expect(h.deps.reports.get(draft.reportDraftId).aiNarrative).toBeNull();
    expect(h.snapshot()).toEqual(before);
  },
);
