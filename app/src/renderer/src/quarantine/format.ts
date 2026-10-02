import type { QuarantineItemDTO, QuarantineStatus } from './types';

export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function formatWhen(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('es-CO');
}

export function quarantineStatusLabel(status: QuarantineStatus): string {
  if (status === 'PENDING') return 'Pendiente';
  if (status === 'QUARANTINED') return 'En cuarentena';
  if (status === 'RESTORED') return 'Restaurado';
  if (status === 'DELETED') return 'Eliminado';
  return 'Falló';
}

export function quarantineWhen(item: QuarantineItemDTO): string | null {
  if (item.status === 'RESTORED') return item.restoredAt;
  if (item.status === 'DELETED') return item.deletedAt;
  return item.quarantinedAt;
}

export function quarantineReason(verdict: string): string {
  return `Resultado ${verdict} confirmado por el usuario`;
}

export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'No se pudo completar la acción.';
}
