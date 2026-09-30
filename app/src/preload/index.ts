import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  SYSTEM_GET_STATUS,
  SYSTEM_RECONNECT_ENGINE,
  type CyberSocApi,
  type SystemStatus,
  DIALOG_SELECT_FILE,
  DIALOG_SELECT_FOLDER,
  SCAN_START,
  SCAN_CANCEL,
  SCAN_GET_JOB,
  SCAN_LIST_JOBS,
  SCAN_LIST_RESULTS,
  SCAN_PROGRESS,
  SCAN_FINISHED,
  type ScanProgress,
  type ScanJobDTO,
} from '../shared/ipc';

function subscribe<T>(
  channel: typeof SCAN_PROGRESS | typeof SCAN_FINISHED,
  callback: (value: T) => void,
): () => void {
  if (typeof callback !== 'function')
    throw new TypeError('Se requiere una función de suscripción.');
  let active = true;
  const listener = (_event: IpcRendererEvent, value: T) => {
    if (active) callback(value);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: CyberSocApi = {
  dialog: {
    selectFolder: () => ipcRenderer.invoke(DIALOG_SELECT_FOLDER),
    selectFile: () => ipcRenderer.invoke(DIALOG_SELECT_FILE),
  },
  scan: {
    start: (target) => ipcRenderer.invoke(SCAN_START, target),
    cancel: (jobId) => ipcRenderer.invoke(SCAN_CANCEL, jobId),
    getJob: (jobId) => ipcRenderer.invoke(SCAN_GET_JOB, jobId),
    listJobs: (limit) =>
      limit === undefined
        ? ipcRenderer.invoke(SCAN_LIST_JOBS)
        : ipcRenderer.invoke(SCAN_LIST_JOBS, limit),
    listResults: (query) => ipcRenderer.invoke(SCAN_LIST_RESULTS, query),
    onProgress: (callback) => subscribe<ScanProgress>(SCAN_PROGRESS, callback),
    onFinished: (callback) => subscribe<ScanJobDTO>(SCAN_FINISHED, callback),
  },
  system: {
    getStatus: (): Promise<SystemStatus> =>
      ipcRenderer.invoke(SYSTEM_GET_STATUS),
    reconnectEngine: (): Promise<SystemStatus> =>
      ipcRenderer.invoke(SYSTEM_RECONNECT_ENGINE),
  },
};

contextBridge.exposeInMainWorld('cybersoc', api);
