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

/** Snapshot of the catalog loaded by main; it accepts no paths or SQL from the AI. */
export class ToolCatalogRepository {
  // Invariant: one record per normalized ID/hash. Load O(n), lookup O(1)
  // average; output copies prevent altering the catalog by reference.
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
