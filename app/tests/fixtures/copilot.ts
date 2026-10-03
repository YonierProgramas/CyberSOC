import { resolve } from 'node:path';
import type { Database } from '../../src/core/persistence/Database';
import { ToolReadRepository } from '../../src/core/persistence/ToolReadRepository';
import { ReportBuilder } from '../../src/core/reports/ReportBuilder';
import { createToolRegistry } from '../../src/core/ai/tools';
import type { ToolRegistry } from '../../src/core/ai/tools/ToolRegistry';
import { loadToolCatalog } from '../../src/core/ai/ToolCatalogLoader';
import type { AssistantReplyWire } from '../../src/core/ai/AssistantReply';

/** Catálogo real del motor (reglas YAML y firmas JSON de prueba, todas inofensivas). */
export const ENGINE_DATA = resolve(import.meta.dirname, '../../../engine/data');

/** Zonas fijas de prueba: nunca rutas reales del usuario. */
export const TEST_ZONE_ROOTS = [
  { zone: 'DESCARGAS' as const, path: 'C:\\Pruebas\\Usuario\\Downloads' },
  { zone: 'DOCUMENTOS' as const, path: 'C:\\Pruebas\\Usuario\\Documents' },
  { zone: 'SISTEMA' as const, path: 'C:\\Windows' },
];

/** Herramientas reales de solo lectura sobre la BD de la prueba + borradores de reporte. */
export function copilotDeps(
  db: Database,
  removable: { driveId: string; path: string }[] = [
    { driveId: 'E:', path: 'E:\\' },
  ],
): { tools: ToolRegistry; reports: ReportBuilder } {
  const reports = new ReportBuilder(db);
  const tools = createToolRegistry(
    {
      reads: new ToolReadRepository(db),
      catalog: loadToolCatalog(ENGINE_DATA),
      zoneRoots: () => TEST_ZONE_ROOTS,
      removableDrives: async () => removable,
    },
    reports,
  );
  return { tools, reports };
}

/** Respuesta final mínima del Copilot v2 (sin referencias, acciones, reporte ni plan). */
export function final(
  answer: string,
  extra: Partial<AssistantReplyWire> = {},
): AssistantReplyWire {
  return {
    answer,
    references: [],
    suggestedActions: [],
    report: [],
    scanPlan: [],
    ...extra,
  };
}
