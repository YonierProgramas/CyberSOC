import type { z } from 'zod';
import type {
  fileErrorCodeSchema,
  fileScanStatusSchema,
} from '../../shared/protocol';

export type FileScanStatus = z.infer<typeof fileScanStatusSchema>;
export type FileErrorCode = z.infer<typeof fileErrorCodeSchema>;

export interface FileTask {
  jobId: string;
  taskId: string;
  seq: number;
  path: string;
}
