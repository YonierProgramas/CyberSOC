/**
 * Common user message of the S3 prompts: an introduction, the context between
 * <contexto> tags and, on retry, the reasons for the earlier rejection (from a validator, never
 * model text).
 */
export function buildDelimitedPrompt(
  intro: string,
  contextJson: string,
  previousErrors: readonly string[] = [],
): string {
  // The JSON must come from toPromptSafeJson: without literal < or > it cannot close the tag.
  if (/[<>]/.test(contextJson)) {
    throw new Error(
      'The context must be serialized with toPromptSafeJson (without literal < or >).',
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
