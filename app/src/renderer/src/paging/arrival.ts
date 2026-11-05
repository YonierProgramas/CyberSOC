/**
 * Decide si un aviso de escaneo puede ser un análisis nuevo.
 * Un id ya mostrado en el filtro vigente es una actualización: no se consulta
 * de nuevo la primera página. Un id nunca visto, o uno que aún no cumplía el
 * filtro y acaba de terminar, sí se comprueba.
 */
export function shouldProbeArrival(input: {
  matched: boolean;
  seen: boolean;
  finished: boolean;
}): boolean {
  if (input.matched) return false;
  return !input.seen || input.finished;
}

/**
 * La página 1 solo se muestra si el alta aparece en la consulta filtrada.
 * Si el filtro lo excluye, el lector conserva el offset.
 */
export function offsetAfterArrival(
  offset: number,
  appearsOnFirstPage: boolean,
): number {
  return appearsOnFirstPage ? 0 : offset;
}

/**
 * Reabrir el archivo conserva la página hasta que el total crece.
 * La primera lectura no tiene línea base: un total mayor que cero no es un alta.
 * Una conversación existente que cambia de fecha no aumenta el total.
 */
export function archiveOffsetAfterReopen(input: {
  offset: number;
  previousTotal: number;
  nextTotal: number;
  hasBaseline: boolean;
}): number {
  if (input.hasBaseline && input.nextTotal > input.previousTotal) return 0;
  return input.offset;
}
