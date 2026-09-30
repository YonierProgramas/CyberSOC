import { z } from 'zod';

export const aiStatusSchema = z.enum([
  'NOT_REQUIRED',
  'PENDING',
  'RUNNING',
  'RETRY_WAIT',
  'COMPLETED',
  'UNAVAILABLE',
  'INVALID',
  'NOT_CONFIGURED',
]);
export type AIStatus = z.infer<typeof aiStatusSchema>;
export const riskLevelSchema = z.enum(['BAJO', 'MEDIO', 'ALTO', 'CRÍTICO']);
export type RiskLevel = z.infer<typeof riskLevelSchema>;
export const scoreSchema = z.number().int().min(0).max(100);

export const jsonTextSchema = z.string().refine((value) => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}, 'Se requiere texto JSON válido');
