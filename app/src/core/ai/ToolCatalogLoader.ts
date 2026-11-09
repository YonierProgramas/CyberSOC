import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ToolCatalogRepository,
  type RuleInfo,
  type SignatureInfo,
} from '../persistence/ToolCatalogRepository';

const MAX_CONDITIONS = 600;
const SEVERITIES = new Set(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

/**
 * Reads an engine rule (`engine/data/rules/*.yaml`) without new dependencies. It only uses the
 * top-level keys `id`, `description` and `severity`, and summarizes the `conditions` block
 * as text: it is information for get_rule_info and is never executed or evaluated.
 */
export function parseRuleYaml(text: string): RuleInfo {
  const scalars = new Map<string, string>();
  const conditions: string[] = [];
  let inConditions = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const indented = /^\s/.test(raw);
    if (!indented) {
      inConditions = false;
      const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(raw);
      if (!match) continue;
      const [, key, value] = match;
      if (key === 'conditions' && value === '') inConditions = true;
      else scalars.set(key!, unquote(value!.trim()));
    } else if (inConditions) conditions.push(raw.trim());
  }
  const summary = conditions.join('; ');
  return {
    id: scalars.get('id') ?? '',
    description: scalars.get('description') ?? scalars.get('name') ?? '',
    severity: SEVERITIES.has(scalars.get('severity') ?? '')
      ? (scalars.get('severity') as RuleInfo['severity'])
      : 'INFO',
    conditions:
      summary.length > MAX_CONDITIONS
        ? `${summary.slice(0, MAX_CONDITIONS)}…`
        : summary,
  };
}

const signatureFileSchema = z.object({
  signatures: z.array(
    z.object({ id: z.string(), title: z.string(), sha256: z.string() }),
  ),
});

/** Real engine catalog: YAML rules and JSON signatures from `engine/data`. Read-only. */
export function loadToolCatalog(engineDataDir: string): ToolCatalogRepository {
  const rulesDir = join(engineDataDir, 'rules');
  const rules = readdirSync(rulesDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => parseRuleYaml(readFileSync(join(rulesDir, name), 'utf8')));
  const signaturesDir = join(engineDataDir, 'signatures');
  const signatures: SignatureInfo[] = readdirSync(signaturesDir)
    .filter((name) => /\.json$/i.test(name))
    .sort()
    .flatMap((name) =>
      signatureFileSchema
        .parse(JSON.parse(readFileSync(join(signaturesDir, name), 'utf8')))
        .signatures.map(({ id, title, sha256 }) => ({ id, title, sha256 })),
    );
  return new ToolCatalogRepository(rules, signatures);
}

function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}
