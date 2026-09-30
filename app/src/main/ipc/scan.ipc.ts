import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { Database } from '../../core/persistence/Database';
import { ScanJobRepository } from '../../core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../../core/persistence/ScanResultRepository';
import type { ScanOrchestrator } from '../../core/scan/ScanOrchestrator';
import {
  SCAN_START,
  SCAN_CANCEL,
  SCAN_GET_JOB,
  SCAN_LIST_JOBS,
  SCAN_LIST_RESULTS,
  SCAN_PROGRESS,
  SCAN_FINISHED,
  type ScanJobDTO,
  type ScanResultDTO,
  type Page,
  type ScanProgress,
} from '../../shared/ipc';
import {
  existingScanTarget,
  requireTrustedSender,
  scanTargetSchema,
  trustedWindow,
} from './scan-validation';

const idSchema = z.string().min(1);
const startArguments = z.tuple([scanTargetSchema]);
const idArguments = z.tuple([idSchema]);
const listArguments = z.union([z.tuple([]), z.tuple([z.int().min(0)])]);
const pageArguments = z.tuple([
  z.strictObject({
    jobId: idSchema,
    offset: z.int().min(0),
    limit: z.int().min(1).max(200),
  }),
]);

export function registerScanIpc(
  getWindow: () => BrowserWindow | null,
  trustedRendererUrl: string,
  orchestrator: ScanOrchestrator,
  database: Database,
): () => Promise<void> {
  let disposed = false;
  let activeJobId: string | null = null;
  const jobs = new ScanJobRepository(database);
  const results = new ScanResultRepository(database);
  // Count the persisted rows rather than inferring total from a possibly interrupted counter update.
  const count = database.prepare(
    'SELECT COUNT(*) AS total FROM scan_results WHERE job_id = ?',
  );
  const validate = (event: IpcMainInvokeEvent) =>
    requireTrustedSender(getWindow, trustedRendererUrl, event);
  const getJob = (id: string): ScanJobDTO => {
    const job = jobs.get(id);
    if (!job) throw new Error('No existe el trabajo de escaneo.');
    return job;
  };

  ipcMain.handle(
    SCAN_START,
    async (event, ...args: unknown[]): Promise<{ jobId: string }> => {
      validate(event);
      const [input] = startArguments.parse(args);
      const target = await existingScanTarget(input);
      validate(event);
      if (disposed) throw new Error('El IPC de escaneo se está cerrando.');
      const jobId = orchestrator.start(target);
      activeJobId = jobId;
      return { jobId };
    },
  );
  ipcMain.handle(
    SCAN_CANCEL,
    async (event, ...args: unknown[]): Promise<void> => {
      validate(event);
      const [id] = idArguments.parse(args);
      await orchestrator.cancel(id);
    },
  );
  ipcMain.handle(SCAN_GET_JOB, (event, ...args: unknown[]): ScanJobDTO => {
    validate(event);
    const [id] = idArguments.parse(args);
    return getJob(id);
  });
  ipcMain.handle(SCAN_LIST_JOBS, (event, ...args: unknown[]): ScanJobDTO[] => {
    validate(event);
    const [limit] = listArguments.parse(args);
    return jobs.listRecent(limit);
  });
  ipcMain.handle(
    SCAN_LIST_RESULTS,
    (event, ...args: unknown[]): Page<ScanResultDTO> => {
      validate(event);
      const [query] = pageArguments.parse(args);
      getJob(query.jobId);
      return {
        items: results.listByJob(query.jobId, query.offset, query.limit),
        offset: query.offset,
        limit: query.limit,
        total: Number(count.get(query.jobId)!.total),
      };
    },
  );

  const progress = (value: ScanProgress) =>
    trustedWindow(getWindow, trustedRendererUrl)?.webContents.send(
      SCAN_PROGRESS,
      value,
    );
  const finished = (value: ScanJobDTO) => {
    if (activeJobId === value.id) activeJobId = null;
    trustedWindow(getWindow, trustedRendererUrl)?.webContents.send(
      SCAN_FINISHED,
      value,
    );
  };
  orchestrator.on('progress', progress);
  orchestrator.on('finished', finished);
  return async () => {
    if (disposed) return;
    disposed = true;
    orchestrator.off('progress', progress);
    orchestrator.off('finished', finished);
    for (const channel of [
      SCAN_START,
      SCAN_CANCEL,
      SCAN_GET_JOB,
      SCAN_LIST_JOBS,
      SCAN_LIST_RESULTS,
    ])
      ipcMain.removeHandler(channel);
    if (activeJobId !== null) await orchestrator.cancel(activeJobId);
  };
}
