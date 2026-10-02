export type QuarantineStatus =
  'PENDING' | 'QUARANTINED' | 'RESTORED' | 'DELETED' | 'FAILED';

/** Lo que T4.4 debe exponer. No incluye la clave ni el IV de la bóveda. */
export interface QuarantineItemDTO {
  id: string;
  resultId: string | null;
  originalPath: string;
  sha256: string;
  sizeBytes: number;
  reason: string;
  verdictSnapshot: string;
  status: QuarantineStatus;
  quarantinedAt: string | null;
  restoredAt: string | null;
  restoredTo: string | null;
  deletedAt: string | null;
  errorMessage: string | null;
}

export interface QuarantineApi {
  list(query?: { status?: QuarantineStatus }): Promise<QuarantineItemDTO[]>;
  quarantine(resultId: string): Promise<QuarantineItemDTO>;
  restore(
    itemId: string,
    opts: { trustHash: boolean; targetPath?: string },
  ): Promise<QuarantineItemDTO>;
  delete(itemId: string): Promise<void>;
}

export function quarantineApi(): QuarantineApi | null {
  const bridge = window.cybersoc as { quarantine?: QuarantineApi };
  return bridge.quarantine ?? null;
}

export const QUARANTINE_UNAVAILABLE =
  'La cuarentena todavía no está conectada. Falta el canal quarantine.* (T4.4).';
