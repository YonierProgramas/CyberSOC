export type ScanJobStatus =
  | 'CREATED'
  | 'DISCOVERING'
  | 'SCANNING'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'FAILED';

export interface ScanJobCounters {
  filesDiscovered: number;
  filesProcessed: number;
  filesError: number;
  filesSkipped: number;
  bytesProcessed: number;
}

export interface ScanJobTarget {
  id: string;
  targetPath: string;
  targetKind: 'FILE' | 'FOLDER';
}

const nonTerminalStates: readonly ScanJobStatus[] = [
  'CREATED',
  'DISCOVERING',
  'SCANNING',
  'CANCELLING',
];

/** In-memory lifecycle only; discovery, engine calls and persistence belong to the orchestrator. */
export class ScanJob {
  readonly id: string;
  readonly targetPath: string;
  readonly targetKind: 'FILE' | 'FOLDER';
  readonly createdAt: string;
  private readonly clock: () => string;
  #status: ScanJobStatus = 'CREATED';
  #startedAt: string | null = null;
  #finishedAt: string | null = null;
  #errorMessage: string | null = null;
  #counters: ScanJobCounters = {
    filesDiscovered: 0,
    filesProcessed: 0,
    filesError: 0,
    filesSkipped: 0,
    bytesProcessed: 0,
  };

  constructor(
    target: ScanJobTarget,
    clock: () => string = () => new Date().toISOString(),
  ) {
    this.id = target.id;
    this.targetPath = target.targetPath;
    this.targetKind = target.targetKind;
    this.clock = clock;
    this.createdAt = clock();
  }

  get status(): ScanJobStatus {
    return this.#status;
  }
  get startedAt(): string | null {
    return this.#startedAt;
  }
  get finishedAt(): string | null {
    return this.#finishedAt;
  }
  get errorMessage(): string | null {
    return this.#errorMessage;
  }
  get counters(): Readonly<ScanJobCounters> {
    return { ...this.#counters };
  }

  beginDiscovery(): void {
    this.transition('DISCOVERING', ['CREATED']);
  }

  beginScanning(): void {
    this.transition('SCANNING', ['DISCOVERING']);
  }

  requestCancel(): void {
    this.transition('CANCELLING', ['CREATED', 'DISCOVERING', 'SCANNING']);
  }

  markCancelled(): void {
    this.transition('CANCELLED', ['CANCELLING']);
  }

  complete(): void {
    this.transition('COMPLETED', ['SCANNING']);
  }

  fail(reason: string): void {
    if (reason.trim().length === 0)
      throw new Error('El fallo requiere un motivo.');
    this.transition('FAILED', nonTerminalStates);
    this.#errorMessage = reason;
  }

  /** Absolute snapshots, including the file finishing while CANCELLING. */
  updateCounters(counters: ScanJobCounters): void {
    if (!nonTerminalStates.includes(this.#status)) {
      throw new Error(`No se pueden actualizar contadores en ${this.#status}.`);
    }
    const next: ScanJobCounters = {
      filesDiscovered: counters.filesDiscovered,
      filesProcessed: counters.filesProcessed,
      filesError: counters.filesError,
      filesSkipped: counters.filesSkipped,
      bytesProcessed: counters.bytesProcessed,
    };
    for (const value of Object.values(next)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(
          'Los contadores deben ser enteros no negativos seguros.',
        );
      }
    }
    this.#counters = next;
  }

  private transition(
    next: ScanJobStatus,
    allowed: readonly ScanJobStatus[],
  ): void {
    if (!allowed.includes(this.#status)) {
      throw new Error(`Transición inválida: ${this.#status} → ${next}.`);
    }
    // Read the clock before changing state, so a failed clock leaves the entity intact.
    const at = this.clock();
    if (next === 'DISCOVERING') this.#startedAt = at;
    if (!nonTerminalStates.includes(next)) this.#finishedAt = at;
    this.#status = next;
  }
}
