/**
 * The Copilot has no receipts for write operations: it cannot claim one.
 * This barrier recognizes explicit claims in Spanish; it is not a universal
 * natural-language verifier. Integrity depends on the read-only tools.
 * Clauses are checked separately so that «no puedo..., pero ya borré...» cannot evade
 * the rejection. Legitimate refusals are kept without granting any ability to act.
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
      // Only negation adjacent to THIS claim; «no solo» is not a negation.
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
