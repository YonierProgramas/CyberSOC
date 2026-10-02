import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import { type ToolContext } from './context';

export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'lookup_hash',
    description:
      'Consulta cuántas veces se vio un SHA-256, su firma local y la allowlist.',
    arguments: z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/i) }),
    execute: ({ sha256 }) => {
      const hash = sha256.toLowerCase();
      return {
        sha256: hash,
        ...context.reads.hash(hash),
        signature: context.catalog.signature(hash),
      };
    },
  });
}
