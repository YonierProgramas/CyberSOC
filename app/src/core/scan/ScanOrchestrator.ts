import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../config/AppConfig';
import { ScanJob, type ScanJobStatus } from '../domain/ScanJob';
import { RpcRemoteError, RpcTimeoutError } from '../engine/EngineClient';
import type { EngineProcess } from '../engine/EngineProcess';
import type {
  ScanJobRecord,
  ScanJobRepository,
} from '../persistence/ScanJobRepository';
import type { ScanResultRepository } from '../persistence/ScanResultRepository';
import { engineResultSchema, type EngineResult } from '../../shared/protocol';
import { FileDiscovery } from './FileDiscovery';
import { ProgressThrottle } from './ProgressThrottle';
import { ScanQueue } from './ScanQueue';

export interface ScanTarget {
  kind: 'FILE' | 'FOLDER';
  path: string;
}
export interface ScanProgress {
  jobId: string;
  status: ScanJobStatus;
  discovered: number;
  processed: number;
  errors: number;
  skipped: number;
  discoveryDone: boolean;
  percent: number | null;
  currentPath?: string;
  elapsedMs: number;
}

export type ScanEngine = Pick<
  EngineProcess,
  'scanFile' | 'reconnect' | 'getState'
>;
export type ScanDiscovery = Pick<
  FileDiscovery,
  'discover' | 'peakStackSize' | 'dirsVisited' | 'skippedLinks'
>;
export interface ScanDependencies {
  config: () => AppConfig;
  engine: ScanEngine;
  jobs: Pick<ScanJobRepository, 'create' | 'updateStatus' | 'updateCounters'>;
  results: Pick<ScanResultRepository, 'insertResult'>;
  createDiscovery?: () => ScanDiscovery;
  sizeOf?: (path: string) => Promise<number>;
  onError?: (error: unknown) => void;
}

interface Task {
  taskId: string;
  seq: number;
  path: string;
}
interface Run {
  job: ScanJob;
  record: ScanJobRecord;
  config: AppConfig;
  discovery: ScanDiscovery;
  controller: AbortController;
  queue: ScanQueue<Task>;
  throttle: ProgressThrottle<ScanProgress>;
  started: number;
  discoveryMs: number;
  scanningMs: number;
  discoveryDone: boolean;
  restarts: number;
  currentPath?: string;
  failure?: Error;
  done: Promise<void>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// Stop waiting for filesystem/discovery work that cannot itself be interrupted.
// Its late completion is observed but cannot enqueue work or write results.
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

function timed<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RpcTimeoutError('scan.file', timeoutMs)),
      timeoutMs,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function fileTimeoutMs(base: number, sizeBytes: number): number {
  const size = Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : 0;
  // Node timers cannot represent intervals larger than a signed 32-bit integer.
  return Math.min(2_147_483_647, base + Math.ceil((size / 1_048_576) * 1_000));
}

export class ScanOrchestrator extends EventEmitter<{
  progress: [ScanProgress];
  finished: [ScanJobRecord];
}> {
  private active: Run | null = null;

  constructor(private readonly dependencies: ScanDependencies) {
    super();
  }

  start(target: ScanTarget): string {
    if (this.active) throw new Error('Ya hay un escaneo activo.');
    const state = this.dependencies.engine.getState();
    if (state.status !== 'connected')
      throw new Error('Conecta el motor antes de iniciar el escaneo.');
    const config = structuredClone(this.dependencies.config());
    const job = new ScanJob({
      id: randomUUID(),
      targetPath: target.path,
      targetKind: target.kind,
    });
    const queue = new ScanQueue<Task>(config);
    const discovery =
      this.dependencies.createDiscovery?.() ?? new FileDiscovery();
    const record = this.dependencies.jobs.create({
      id: job.id,
      targetPath: job.targetPath,
      targetKind: job.targetKind,
      engineVersion: state.engineVersion,
      protocolVersion: state.protocol,
      createdAt: job.createdAt,
    });
    const run: Run = {
      job,
      record,
      config,
      discovery,
      queue,
      controller: new AbortController(),
      throttle: new ProgressThrottle((progress) =>
        this.notify('progress', progress),
      ),
      started: performance.now(),
      discoveryMs: 0,
      scanningMs: 0,
      discoveryDone: false,
      restarts: 0,
      done: Promise.resolve(),
    };
    this.active = run;
    // Defer events until start has returned the id and installed the completion promise.
    run.done = Promise.resolve().then(() => this.execute(run));
    return job.id;
  }

  async cancel(jobId: string): Promise<void> {
    const run = this.active;
    if (!run || run.job.id !== jobId)
      throw new Error('El trabajo no está activo.');
    if (['CREATED', 'DISCOVERING', 'SCANNING'].includes(run.job.status)) {
      run.job.requestCancel();
      this.stopProducer(run);
      try {
        this.save(run);
      } catch (error) {
        run.failure = asError(error);
      }
      this.progress(run);
    }
    await run.done;
  }

  private stopProducer(run: Run): void {
    run.controller.abort();
    run.queue.close();
    run.queue.drain();
  }

  private async execute(run: Run): Promise<void> {
    const heartbeat = setInterval(() => this.progress(run), 1_000);
    let final = run.record;
    try {
      if (run.job.status === 'CREATED') {
        run.job.beginDiscovery();
        this.save(run);
        this.progress(run);
        const guard = async (work: Promise<void>) => {
          try {
            await work;
          } catch (error) {
            if (!run.controller.signal.aborted) {
              run.failure ??= asError(error);
              this.stopProducer(run);
            }
          }
        };
        await Promise.all([guard(this.produce(run)), guard(this.consume(run))]);
      }
      if (run.failure) run.job.fail(run.failure.message);
      else if (run.job.status === 'CANCELLING') run.job.markCancelled();
      else run.job.complete();
      final = this.save(run);
    } catch (error) {
      this.stopProducer(run);
      final = {
        ...this.snapshot(run),
        status: 'FAILED',
        errorMessage: asError(error).message,
        finishedAt: new Date().toISOString(),
      };
      try {
        this.dependencies.jobs.updateStatus(run.job.id, 'FAILED', {
          errorMessage: final.errorMessage,
          finishedAt: final.finishedAt,
        });
      } catch (persistenceError) {
        this.report(persistenceError);
      }
      this.report(error);
    } finally {
      clearInterval(heartbeat);
      run.queue.close();
      run.queue.drain();
      this.progress(run, final.status);
      await run.throttle.flush();
      run.throttle.dispose();
      if (this.active === run) this.active = null;
      this.notify('finished', final);
    }
  }

  private async produce(run: Run): Promise<void> {
    const started = performance.now();
    const iterator = run.discovery.discover(
      run.job.targetPath,
      { strategy: 'dfs' },
      run.controller.signal,
    );
    try {
      let seq = 0;
      while (true) {
        const next = await abortable(iterator.next(), run.controller.signal);
        run.controller.signal.throwIfAborted();
        if (next.done) break;
        run.job.updateCounters({
          ...run.job.counters,
          filesDiscovered: run.job.counters.filesDiscovered + 1,
        });
        this.progress(run);
        await run.queue.put(
          { path: next.value.path, seq: seq++, taskId: randomUUID() },
          run.controller.signal,
        );
      }
      run.discoveryDone = true;
      run.job.beginScanning();
      this.save(run);
      this.progress(run);
    } finally {
      run.discoveryMs = performance.now() - started;
      run.queue.close();
      // Do not block cancellation on a pending lstat/readdir inside the generator.
      void iterator
        .return(undefined)
        .catch((error: unknown) => this.report(error));
    }
  }

  private async consume(run: Run): Promise<void> {
    const started = performance.now();
    try {
      while (!run.controller.signal.aborted) {
        const task = await run.queue.take();
        if (!task || run.controller.signal.aborted) return;
        let size = 0;
        try {
          size = await abortable(
            this.dependencies.sizeOf
              ? this.dependencies.sizeOf(task.path)
              : lstat(task.path).then((stat) => stat.size),
            run.controller.signal,
          );
        } catch {
          run.controller.signal.throwIfAborted();
        }
        if (run.controller.signal.aborted) return;
        run.currentPath = task.path;
        this.progress(run);
        const timeoutMs = fileTimeoutMs(
          run.config.engine.requestTimeoutMs,
          size,
        );
        const begin = performance.now();
        let result: EngineResult;
        let broken = false;
        try {
          result = await timed(
            this.dependencies.engine.scanFile(
              {
                jobId: run.job.id,
                taskId: task.taskId,
                path: task.path,
                options: {
                  maxBytes: run.config.scan.maxFileSizeMB * 1_048_576,
                },
              },
              timeoutMs,
            ),
            timeoutMs,
          );
        } catch (error) {
          if (error instanceof RpcRemoteError || error instanceof z.ZodError)
            throw error;
          broken = true;
          result = {
            taskId: task.taskId,
            status: 'ERROR',
            evidence: [],
            // Sin respuesta del motor no hay una traza de capas verificable.
            layers: [],
            error: {
              code:
                error instanceof RpcTimeoutError ? 'TIMEOUT' : 'ENGINE_CRASHED',
              message: asError(error).message,
            },
            durationMs: performance.now() - begin,
            engineVersion: run.record.engineVersion ?? '',
          };
        }
        result = engineResultSchema.parse(result);
        if (result.taskId !== task.taskId)
          throw new Error('El motor respondió para otra tarea.');
        // Only the in-flight file may finish after requestCancel; no new task is started.
        this.dependencies.results.insertResult({
          id: task.taskId,
          jobId: run.job.id,
          seq: task.seq,
          path: task.path,
          fileName: result.file?.name ?? basename(task.path),
          extension: result.file?.extension,
          sizeBytes: result.file?.sizeBytes,
          modifiedAt: result.file?.modifiedAt,
          status: result.status,
          sha256: result.hashes?.sha256,
          errorCode: result.error?.code,
          errorMessage: result.error?.message,
          durationMs: result.durationMs,
        });
        const counters = run.job.counters;
        run.job.updateCounters({
          ...counters,
          filesProcessed: counters.filesProcessed + 1,
          filesError: counters.filesError + Number(result.status === 'ERROR'),
          filesSkipped:
            counters.filesSkipped + Number(result.status === 'SKIPPED'),
          bytesProcessed:
            counters.bytesProcessed +
            (result.status === 'SCANNED' ? (result.file?.sizeBytes ?? 0) : 0),
        });
        run.currentPath = undefined;
        this.save(run);
        this.progress(run);
        if (broken) {
          if (run.restarts >= 3)
            throw new Error('El motor falló después de 3 reinicios.');
          run.restarts += 1;
          const state = await this.dependencies.engine.reconnect();
          if (state.status !== 'connected')
            throw new Error('No se pudo reiniciar el motor.');
        }
      }
    } finally {
      run.scanningMs = performance.now() - started;
    }
  }

  private metrics(run: Run): string {
    return JSON.stringify({
      peakStackSize: run.discovery.peakStackSize,
      peakQueueSize: run.queue.peakSize,
      producerBlockedMs: run.queue.producerBlockedMs,
      dirsVisited: run.discovery.dirsVisited,
      skippedLinks: run.discovery.skippedLinks,
      engineRestarts: run.restarts,
      // The discovery and consumer phases overlap; durations are not additive.
      discoveryDurationMs: run.discoveryMs,
      scanningDurationMs: run.scanningMs,
      totalDurationMs: performance.now() - run.started,
    });
  }

  private save(run: Run): ScanJobRecord {
    const record = this.snapshot(run);
    this.dependencies.jobs.updateCounters(run.job.id, {
      ...run.job.counters,
      metricsJson: record.metricsJson,
    });
    this.dependencies.jobs.updateStatus(run.job.id, run.job.status, {
      startedAt: run.job.startedAt,
      finishedAt: run.job.finishedAt,
      errorMessage: run.job.errorMessage,
    });
    return record;
  }

  private snapshot(run: Run): ScanJobRecord {
    return {
      ...run.record,
      ...run.job.counters,
      status: run.job.status,
      startedAt: run.job.startedAt,
      finishedAt: run.job.finishedAt,
      errorMessage: run.job.errorMessage,
      metricsJson: this.metrics(run),
    };
  }

  private progress(run: Run, status = run.job.status): void {
    const counters = run.job.counters;
    run.throttle.push({
      jobId: run.job.id,
      status,
      discovered: counters.filesDiscovered,
      processed: counters.filesProcessed,
      errors: counters.filesError,
      skipped: counters.filesSkipped,
      discoveryDone: run.discoveryDone,
      percent: run.discoveryDone
        ? counters.filesDiscovered === 0
          ? 100
          : (counters.filesProcessed / counters.filesDiscovered) * 100
        : null,
      currentPath: run.currentPath,
      elapsedMs: performance.now() - run.started,
    });
  }

  private notify(
    event: 'progress' | 'finished',
    value: ScanProgress | ScanJobRecord,
  ): void {
    for (const listener of this.rawListeners(event)) {
      try {
        Reflect.apply(listener, this, [value]);
      } catch (error) {
        this.report(error);
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.dependencies.onError?.(error);
    } catch {
      /* A logging/subscriber failure must not break scan cleanup. */
    }
  }
}
