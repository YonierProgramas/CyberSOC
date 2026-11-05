import { localDateSchema } from '../../shared/history-schemas';

export function localDateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
/** Aritmética civil UTC: avanzar un día no presupone 24 horas en la zona local. */
export function shiftCivilDate(value: string, days: number): string {
  localDateSchema.parse(value);
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function localStart(value: string): string {
  localDateSchema.parse(value);
  const date = new Date(`${value}T00:00:00`);
  return date.toISOString();
}
export function localEndExclusive(value: string): string {
  localDateSchema.parse(value);
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + 1);
  // Fin abierto de las fechas de cuatro dígitos: ':' ordena después de '9'.
  return date.getFullYear() > 9999 ? ':' : date.toISOString();
}
export function civilDayCount(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000 +
    1
  );
}
