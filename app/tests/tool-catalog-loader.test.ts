import { expect, it } from 'vitest';
import {
  loadToolCatalog,
  parseRuleYaml,
} from '../src/core/ai/ToolCatalogLoader';
import { ENGINE_DATA } from './fixtures/copilot';

it('carga las 4 reglas YAML y las firmas JSON reales del motor', () => {
  const catalog = loadToolCatalog(ENGINE_DATA);
  expect(catalog.rule('R-TEST-DOWNLOADER')).toEqual({
    id: 'R-TEST-DOWNLOADER',
    description: 'Regla de prueba que busca un marcador inofensivo en scripts',
    severity: 'HIGH',
    conditions:
      'fileTypes: [SCRIPT_PS1, TEXT]; maxScanBytes: 4194304; strings:; any: ["CYBERSOC_TEST_RULE_DOWNLOADER"]',
  });
  for (const id of ['R-TEST-PAIR', 'R-TEST-UTF16', 'R-TEST-HEX'])
    expect(catalog.rule(id).id).toBe(id);
  expect(catalog.rule('R-TEST-HEX').severity).toBe('CRITICAL');
  expect(() => catalog.rule('R-INVENTADA')).toThrow('NOT_FOUND');
  expect(
    catalog.signature(
      '36e834c158255b064df10679eec89de928cc729fb5d8cabd837119e491f1ee07',
    ),
  ).toMatchObject({ id: 'CSD-TEST-001' });
});

it('parseRuleYaml: comillas, comentarios, severidad desconocida y condiciones largas', () => {
  const rule = parseRuleYaml(
    [
      '# comentario',
      'id: "R-X"',
      "name: 'Nombre'",
      'severity: EXTREMA',
      'conditions:',
      ...Array.from({ length: 80 }, (_, i) => `  - linea ${i} con texto`),
      'points: 5',
    ].join('\r\n'),
  );
  expect(rule.id).toBe('R-X');
  expect(rule.description).toBe('Nombre'); // sin description usa name
  expect(rule.severity).toBe('INFO');
  expect(rule.conditions.length).toBeLessThanOrEqual(601);
  expect(rule.conditions.endsWith('…')).toBe(true);
});
