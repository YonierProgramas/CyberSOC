import { describe, expect, it } from 'vitest';
import {
  archiveOffsetAfterReopen,
  offsetAfterArrival,
  shouldProbeArrival,
} from '../../src/renderer/src/paging/arrival';

describe('historial: alta frente a actualización', () => {
  it('un análisis nuevo que entra en el filtro vuelve a la página 1', () => {
    expect(
      shouldProbeArrival({ matched: false, seen: false, finished: false }),
    ).toBe(true);
    expect(offsetAfterArrival(20, true)).toBe(0);
  });

  it('un análisis nuevo que el filtro excluye conserva la página', () => {
    expect(offsetAfterArrival(20, false)).toBe(20);
  });

  it('actualizar un análisis ya listado no vuelve a consultar la primera página', () => {
    expect(
      shouldProbeArrival({ matched: true, seen: true, finished: true }),
    ).toBe(false);
    expect(
      shouldProbeArrival({ matched: true, seen: true, finished: false }),
    ).toBe(false);
  });

  it('un aviso intermedio de un id ya visto no es un alta', () => {
    expect(
      shouldProbeArrival({ matched: false, seen: true, finished: false }),
    ).toBe(false);
  });

  it('al terminar, un id que antes no cumplía el filtro sí se comprueba', () => {
    expect(
      shouldProbeArrival({ matched: false, seen: true, finished: true }),
    ).toBe(true);
    expect(offsetAfterArrival(20, true)).toBe(0);
  });
});

describe('archivo: reabrir sin alta conserva la página', () => {
  it('la primera lectura no trata el total existente como un alta', () => {
    expect(
      archiveOffsetAfterReopen({
        offset: 0,
        previousTotal: 0,
        nextTotal: 49,
        hasBaseline: false,
      }),
    ).toBe(0);
  });

  it('reabrir con el mismo total conserva 21–40', () => {
    expect(
      archiveOffsetAfterReopen({
        offset: 20,
        previousTotal: 49,
        nextTotal: 49,
        hasBaseline: true,
      }),
    ).toBe(20);
  });

  it('una conversación nueva, de 49 a 50, vuelve a la página 1', () => {
    expect(
      archiveOffsetAfterReopen({
        offset: 20,
        previousTotal: 49,
        nextTotal: 50,
        hasBaseline: true,
      }),
    ).toBe(0);
  });
});
