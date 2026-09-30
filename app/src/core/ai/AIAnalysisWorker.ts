import { EventEmitter } from 'node:events';
import { Queue } from '../structures/Queue';
import type { AIStatus } from '../persistence/assessmentTypes';
import { AISecurityService } from './AISecurityService';

interface Pending {
  id: string;
  retries: number;
  due: number;
}

export interface AIResultUpdated {
  resultId: string;
  aiStatus: AIStatus;
}

export class AIAnalysisWorker extends EventEmitter {
  // Invariante FIFO: el frente conserva su turno durante reintentos. enqueue es
  // O(1) amortizado, peek/dequeue O(1); memoria O(n) para n resultados pendientes.
  private readonly queue = new Queue<Pending>();
  // El Set contiene exactamente los IDs en cola, incluido el que está en vuelo.
  // has/add/delete O(1) promedio: evita doble envío automático/manual del mismo ID.
  private readonly scheduled = new Set<string>();
  private active = false;
  private paused = false;
  private failures = 0;
  private openUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private controller: AbortController | undefined;

  constructor(
    private readonly service: AISecurityService,
    private readonly autoLimit: () => number = () => 50,
  ) {
    super();
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    for (const id of this.service.store.pending()) this.schedule(id);
    this.kick();
  }

  enqueueAutomatic(id: string): boolean {
    if (this.scheduled.has(id)) return false;
    const limit = Math.min(50, Math.max(0, Math.floor(this.autoLimit())));
    if (!this.service.store.reserveAutomatic(id, limit)) return false;
    this.schedule(id);
    this.updated(id, 'PENDING');
    this.kick();
    return true;
  }

  analyzeNow(resultId: string): void {
    this.service.store.load(resultId); // Rechazar IDs inexistentes antes de encolar.
    if (this.scheduled.has(resultId)) return;
    this.service.store.setStatus(resultId, 'PENDING');
    this.schedule(resultId);
    this.updated(resultId, 'PENDING');
    this.kick();
  }

  resume(): void {
    this.paused = false;
    this.failures = 0;
    this.openUntil = 0;
    const head = this.queue.peek();
    if (head) {
      head.retries = 0;
      head.due = 0;
      this.status(head.id, 'PENDING');
    }
    this.kick();
  }

  async stop(): Promise<void> {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.running;
    const head = this.queue.peek();
    if (head && this.service.store.results.get(head.id)?.aiStatus === 'RUNNING')
      this.status(head.id, 'PENDING');
  }

  get state() {
    return {
      pending: this.queue.size,
      paused: this.paused,
      openUntil: this.openUntil,
    };
  }

  private schedule(id: string): void {
    if (this.scheduled.has(id)) return;
    this.scheduled.add(id);
    this.queue.enqueue({ id, retries: 0, due: 0 });
  }
  private updated(resultId: string, aiStatus: AIStatus): void {
    this.publish('ai:resultUpdated', { resultId, aiStatus });
  }
  private publish(
    event: 'ai:resultUpdated' | 'workerError',
    value: AIResultUpdated | string,
  ): void {
    for (const listener of this.rawListeners(event)) {
      try {
        Reflect.apply(listener, this, [value]);
      } catch {
        // Un fallo del consumidor (p. ej. una ventana cerrada) no interrumpe la cola.
      }
    }
  }
  private status(id: string, status: AIStatus): void {
    this.service.store.setStatus(id, status);
    this.updated(id, status);
  }
  private finish(): void {
    const item = this.queue.dequeue();
    if (item) this.scheduled.delete(item.id);
  }

  private kick(): void {
    if (!this.active || this.paused || this.running || this.queue.isEmpty())
      return;
    clearTimeout(this.timer);
    const due = Math.max(this.queue.peek()!.due, this.openUntil);
    if (due > Date.now()) {
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          this.kick();
        },
        Math.min(due - Date.now(), 2_147_483_647),
      );
      return;
    }
    this.running = this.process()
      .catch(() => {
        if (this.active) {
          this.paused = true;
          this.publish('workerError', 'No se pudo completar el trabajo de IA.');
        }
      })
      .finally(() => {
        this.running = undefined;
        this.kick();
      });
  }

  private async process(): Promise<void> {
    const item = this.queue.peek()!;
    this.controller = new AbortController();
    const outcome = await this.service.analyze(
      item.id,
      this.controller.signal,
      (state) => this.updated(item.id, state),
    );
    if (!this.active) return;
    if (outcome.status !== 'PROVIDER_ERROR') {
      this.failures = 0;
      this.openUntil = 0;
      this.finish();
      return;
    }
    const error = outcome.error;
    if (error.kind === 'AUTH') {
      this.paused = true;
      return;
    }
    if (error.kind === 'PROVIDER_DOWN' || error.kind === 'TIMEOUT') {
      this.failures++;
      if (this.failures >= 3) {
        this.openUntil = Date.now() + 60_000;
        this.failures = 0;
      }
    } else this.failures = 0;
    if (!error.retryable || item.retries >= 3) {
      this.status(item.id, 'UNAVAILABLE');
      if (error.kind === 'OFFLINE') this.paused = true;
      else this.finish();
      return;
    }
    item.retries++;
    const retryAfter = Number.isFinite(error.retryAfterMs)
      ? Math.max(0, error.retryAfterMs!)
      : 0;
    item.due =
      Date.now() + Math.max(1000 * 2 ** (item.retries - 1), retryAfter);
    this.status(item.id, 'RETRY_WAIT');
  }
}
