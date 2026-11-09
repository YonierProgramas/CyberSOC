import { EventEmitter } from 'node:events';
import { PriorityQueue } from '../structures/PriorityQueue';
import type { AIStatus } from '../persistence/assessmentTypes';
import { AISecurityService } from './AISecurityService';
import type { JobSummaryService } from './JobSummaryService';

interface Pending {
  /** FILE_RESULT: id is a resultId. JOB_SUMMARY: id is a jobId. */
  kind: 'FILE_RESULT' | 'JOB_SUMMARY';
  id: string;
  retries: number;
  due: number;
}

export interface AIResultUpdated {
  resultId: string;
  aiStatus: AIStatus;
}

export interface AIJobSummaryUpdated {
  jobId: string;
  aiStatus: AIStatus;
}

/**
 * Scan summary priority: below any file (file priorities range
 * from 0 to 200), so the highest-risk results are analyzed first.
 */
const JOB_SUMMARY_PRIORITY = -1;

/** Key of the scheduled Set: jobIds carry a prefix so they cannot collide with resultIds. */
function key(item: Pick<Pending, 'kind' | 'id'>): string {
  return item.kind === 'JOB_SUMMARY' ? `job:${item.id}` : item.id;
}

export class AIAnalysisWorker extends EventEmitter {
  // The heap picks the highest risk; its internal seq breaks ties by arrival (FIFO).
  // push/pop O(log n), peek O(1), O(n) memory. The job in progress stays outside:
  // new priorities neither replace it nor skip its backoff/Retry-After.
  private readonly queue = new PriorityQueue<Pending>();
  private current: Pending | undefined;
  // The Set holds exactly the IDs in the heap plus the current job.
  // has/add/delete O(1) average: prevents sending the same ID twice (automatic and manual).
  private readonly scheduled = new Set<string>();
  private active = false;
  private paused = false;
  private failures = 0;
  private openUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private continuation: ReturnType<typeof setImmediate> | undefined;
  private running: Promise<void> | undefined;
  private controller: AbortController | undefined;

  constructor(
    private readonly service: AISecurityService,
    private readonly autoLimit: () => number = () => 50,
    private readonly jobSummaries?: JobSummaryService,
  ) {
    super();
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    for (const id of this.service.store.pending()) this.schedule(id);
    for (const jobId of this.jobSummaries?.store.pending() ?? [])
      this.scheduleJob(jobId);
    this.kick();
  }

  /**
   * Enqueues the AI summary of a finished scan (JOB_SUMMARY). Only for COMPLETED
   * scans without a final summary; returns whether it was enqueued.
   */
  enqueueJobSummary(jobId: string): boolean {
    if (!this.jobSummaries) return false;
    if (this.scheduled.has(key({ kind: 'JOB_SUMMARY', id: jobId })))
      return false;
    if (!this.jobSummaries.store.markPending(jobId)) return false;
    this.scheduleJob(jobId);
    this.jobUpdated(jobId, 'PENDING');
    this.kick();
    return true;
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
    this.service.store.load(resultId); // Reject nonexistent IDs before enqueuing.
    if (this.scheduled.has(resultId)) return;
    this.service.store.setStatus(resultId, 'PENDING');
    this.schedule(resultId);
    this.updated(resultId, 'PENDING');
    this.kick();
  }

  resume(): void {
    if (!this.active || this.running) return;
    if (this.paused) {
      this.paused = false;
      this.failures = 0;
      this.openUntil = 0;
      const head = this.current;
      if (head) {
        head.retries = 0;
        head.due = 0;
        this.itemStatus(head, 'PENDING');
      }
    }
    for (const jobId of this.jobSummaries?.store.paused() ?? []) {
      if (!this.scheduled.has(key({ kind: 'JOB_SUMMARY', id: jobId }))) {
        this.itemStatus({ kind: 'JOB_SUMMARY', id: jobId }, 'PENDING');
        this.scheduleJob(jobId);
      }
    }
    // A corrected credential also recovers results paused before the restart.
    for (const id of this.service.store.pausedResults()) {
      if (!this.scheduled.has(id)) {
        this.status(id, 'PENDING');
        this.schedule(id);
      }
    }
    this.kick();
  }

  async stop(): Promise<void> {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearImmediate(this.continuation);
    this.continuation = undefined;
    this.controller?.abort();
    await this.running;
    const head = this.current;
    if (!head) return;
    const running =
      head.kind === 'JOB_SUMMARY'
        ? this.jobSummaries?.store.status(head.id) === 'RUNNING'
        : this.service.store.results.get(head.id)?.aiStatus === 'RUNNING';
    if (running) this.itemStatus(head, 'PENDING');
  }

  get state() {
    return {
      pending: this.queue.size + (this.current ? 1 : 0),
      paused: this.paused,
      openUntil: this.openUntil,
    };
  }

  private schedule(id: string): void {
    if (this.scheduled.has(id)) return;
    const { result, analysis } = this.service.store.load(id);
    // Uses the engine score and verdict, not the AI opinion.
    const priority =
      (analysis.score ?? 0) + (result.verdict === 'DETECTED' ? 100 : 0);
    this.queue.push({ kind: 'FILE_RESULT', id, retries: 0, due: 0 }, priority);
    this.scheduled.add(id);
  }
  private scheduleJob(jobId: string): void {
    const item: Pending = {
      kind: 'JOB_SUMMARY',
      id: jobId,
      retries: 0,
      due: 0,
    };
    if (this.scheduled.has(key(item))) return;
    this.queue.push(item, JOB_SUMMARY_PRIORITY);
    this.scheduled.add(key(item));
  }
  private jobUpdated(jobId: string, aiStatus: AIStatus): void {
    this.publish('ai:jobSummaryUpdated', { jobId, aiStatus });
  }
  /** Status of a queue element, whether a file or a scan summary. */
  private itemStatus(
    item: Pick<Pending, 'kind' | 'id'>,
    status: AIStatus,
  ): void {
    if (item.kind === 'JOB_SUMMARY') {
      this.jobSummaries?.store.setStatus(item.id, status);
      this.jobUpdated(item.id, status);
    } else this.status(item.id, status);
  }
  private updated(resultId: string, aiStatus: AIStatus): void {
    this.publish('ai:resultUpdated', { resultId, aiStatus });
  }
  private publish(
    event: 'ai:resultUpdated' | 'ai:jobSummaryUpdated' | 'workerError',
    value: AIResultUpdated | AIJobSummaryUpdated | string,
  ): void {
    for (const listener of this.rawListeners(event)) {
      try {
        Reflect.apply(listener, this, [value]);
      } catch {
        // A consumer failure (e.g. a closed window) does not interrupt the queue.
      }
    }
  }
  private status(id: string, status: AIStatus): void {
    this.service.store.setStatus(id, status);
    this.updated(id, status);
  }
  private finish(): void {
    const item = this.current;
    this.current = undefined;
    if (item) this.scheduled.delete(key(item));
  }

  private kick(): void {
    if (!this.active || this.paused || this.running || this.continuation)
      return;
    this.current ??= this.queue.pop();
    if (!this.current) return;
    clearTimeout(this.timer);
    const due = Math.max(this.current.due, this.openUntil);
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
    // Assigning running before publishing RUNNING prevents reentrancy from events.
    this.running = Promise.resolve()
      .then(() => this.process())
      .catch(() => {
        if (this.active) {
          this.paused = true;
          this.publish('workerError', 'No se pudo completar el trabajo de IA.');
        }
      })
      .finally(() => {
        this.running = undefined;
        // A single O(1) continuation, outside the heap/Set: it neither extracts nor duplicates
        // pending. Yielding to the check phase lets IPC, shutdown and UI be served
        // even if the provider resolves immediately; it adds no wait
        // temporal ni cambia prioridades FIFO, backoff o Retry-After.
        if (!this.active || this.paused) return;
        // A future backoff already yields through its timer: arming it now avoids
        // needlessly postponing the registration of its absolute deadline.
        if (Math.max(this.current?.due ?? 0, this.openUntil) > Date.now()) {
          this.kick();
          return;
        }
        this.continuation = setImmediate(() => {
          this.continuation = undefined;
          this.kick();
        });
      });
  }

  private async process(): Promise<void> {
    if (!this.active) return;
    const item = this.current!;
    this.controller = new AbortController();
    const outcome =
      item.kind === 'JOB_SUMMARY' && this.jobSummaries
        ? await this.jobSummaries.summarize(
            item.id,
            this.controller.signal,
            (state) => this.jobUpdated(item.id, state),
          )
        : await this.service.analyze(item.id, this.controller.signal, (state) =>
            this.updated(item.id, state),
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
      this.itemStatus(item, 'UNAVAILABLE');
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
    this.itemStatus(item, 'RETRY_WAIT');
  }
}
