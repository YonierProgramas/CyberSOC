import { ToolRegistry } from './ToolRegistry';
import type { ToolContext } from './context';
import { register as scanSummary } from './get_scan_summary';
import { register as listScans } from './list_scans';
import { register as listResults } from './list_results';
import { register as topRisk } from './get_top_risk_results';
import { register as resultDetail } from './get_result_detail';
import { register as evidence } from './get_evidence';
import { register as ruleInfo } from './get_rule_info';
import { register as aiAnalysis } from './get_ai_analysis';
import { register as quarantine } from './get_quarantine_items';
import { register as compareResults } from './compare_results';
import { register as lookupHash } from './lookup_hash';
import { register as zones } from './list_zones';
import { register as layerReport } from './get_layer_report';
import { registerBuildReport } from './buildReport';
import type { ReportBuilder } from '../../reports/ReportBuilder';

/** main debe inyectar los repositorios y lectores reales; no hay valores ficticios por defecto. */
export function createToolRegistry(
  context: ToolContext,
  reports: ReportBuilder,
): ToolRegistry {
  const registry = new ToolRegistry();
  scanSummary(registry, context);
  listScans(registry, context);
  listResults(registry, context);
  topRisk(registry, context);
  resultDetail(registry, context);
  evidence(registry, context);
  ruleInfo(registry, context);
  aiAnalysis(registry, context);
  quarantine(registry, context);
  compareResults(registry, context);
  lookupHash(registry, context);
  zones(registry, context);
  layerReport(registry, context);
  registerBuildReport(registry, reports);
  return registry;
}
