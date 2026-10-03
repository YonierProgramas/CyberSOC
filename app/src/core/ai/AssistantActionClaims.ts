/**
 * El Copilot no tiene recibos de operaciones de escritura: no puede atribuirse una.
 * Esta barrera reconoce afirmaciones explícitas en español; no es un verificador
 * universal de lenguaje natural. La integridad depende de las herramientas de lectura.
 * Se revisan cláusulas separadas para que «no puedo..., pero ya borré...» no eluda
 * el rechazo. Las negativas legítimas se conservan sin conceder capacidad de actuar.
 */
export function hasUnsupportedActionClaim(text: string): boolean {
  const normalized = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u200b-\u200f\ufeff]/g, '')
    .toLowerCase()
    .replace(/[*_`]/g, '');
  const verbs =
    '(?:borrado|eliminado|restaurado|limpiado|marcado|cambiado|modificado|iniciado|ejecutado|puesto|movido|vaciado|desactivado)';
  const infinitives =
    '(?:borrar|eliminar|restaurar|limpiar|marcar|cambiar|modificar|iniciar|ejecutar|poner|mover|vaciar|desactivar)';
  const past =
    '(?:borre|elimine|restaure|limpie|marque|cambie|modifique|inicie|ejecute|puse|movi|vacie|desactive)';
  const assertion = new RegExp(
    `\\b(?:(?:he|hemos)\\s+(?:ya\\s+)?${verbs}|(?:acabo|acabamos)\\s+de\\s+${infinitives}|${past})\\b`,
    'g',
  );
  for (const clause of normalized.split(/[.!?;:\n]|\b(?:pero|sin embargo)\b/)) {
    for (const match of clause.matchAll(assertion)) {
      const prefix = clause.slice(0, match.index);
      // Solo negación adyacente a ESTA afirmación; «no solo» no es una negación.
      if (
        /\b(?:no|nunca|jamas)\s+(?:(?:yo|lo|la|los|las|ya|aun|todavia)\s+)*$/.test(
          prefix,
        )
      )
        continue;
      const suffix = clause.slice(match.index! + match[0].length);
      if (
        /\b(?:cuarentena|veredictos?|resultados?|archivos?|escaneos?|analisis|protecciones?|clean|limpios?|seguros?)\b/.test(
          suffix,
        ) ||
        /\b(?:lo|la|los|las)\s*$/.test(prefix)
      )
        return true;
    }
  }
  return false;
}
