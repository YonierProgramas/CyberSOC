/**
 * Mensaje de usuario común de los prompts S3: una introducción, el contexto entre etiquetas
 * <contexto> y, en el reintento, los motivos del descarte anterior (de un validador, nunca
 * texto del modelo).
 */
export function buildDelimitedPrompt(
  intro: string,
  contextJson: string,
  previousErrors: readonly string[] = [],
): string {
  // El JSON debe venir de toPromptSafeJson: sin < ni > literales no puede cerrar la etiqueta.
  if (/[<>]/.test(contextJson)) {
    throw new Error(
      'El contexto debe serializarse con toPromptSafeJson (sin < ni > literales).',
    );
  }
  const parts = [intro, `<contexto>\n${contextJson}\n</contexto>`];
  if (previousErrors.length) {
    parts.push(
      [
        'Tu respuesta anterior se descartó por estos motivos:',
        ...previousErrors.map((error) => `- ${error}`),
        'Corrígelos y responde de nuevo.',
      ].join('\n'),
    );
  }
  return parts.join('\n\n');
}
