import { z } from 'zod';

const ruleSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string(),
  severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  conditions: z.string(),
});
const signatureSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
});
export type RuleInfo = z.infer<typeof ruleSchema>;
export type SignatureInfo = z.infer<typeof signatureSchema>;

/** Snapshot del catálogo cargado por main; no acepta rutas ni SQL de la IA. */
export class ToolCatalogRepository {
  // Invariante: un registro por ID/hash normalizado. Carga O(n), búsqueda O(1)
  // promedio; las copias de salida impiden alterar el catálogo por referencia.
  private readonly rules = new Map<string, RuleInfo>();
  private readonly signatures = new Map<string, SignatureInfo>();
  constructor(
    rules: readonly RuleInfo[],
    signatures: readonly SignatureInfo[],
  ) {
    for (const input of rules) {
      const item = ruleSchema.parse(input);
      if (this.rules.has(item.id)) throw new Error('Regla duplicada.');
      this.rules.set(item.id, item);
    }
    for (const input of signatures) {
      const item = signatureSchema.parse(input);
      item.sha256 = item.sha256.toLowerCase();
      if (this.signatures.has(item.sha256)) throw new Error('Firma duplicada.');
      this.signatures.set(item.sha256, item);
    }
  }
  rule(id: string): RuleInfo {
    const item = this.rules.get(id);
    if (!item) throw new Error('NOT_FOUND');
    return { ...item };
  }
  signature(hash: string): SignatureInfo | null {
    const item = this.signatures.get(hash.toLowerCase());
    return item ? { ...item } : null;
  }
}
