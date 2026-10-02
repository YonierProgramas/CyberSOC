import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  QUARANTINE_LIST,
  QUARANTINE_QUARANTINE,
  QUARANTINE_RESTORE,
  QUARANTINE_DELETE,
  QUARANTINE_CHANGED,
  type QuarantineChanged,
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
  SCAN_GET_RESULT,
  SCAN_GET_JOB_SUMMARY,
  SCAN_ANALYZE_NOW,
  SCAN_PROGRESS,
  SCAN_FINISHED,
  AI_RESULT_UPDATED,
  type ScanProgress,
  type ScanJobDTO,
  type AIResultUpdated,
  SETTINGS_AI_SET_API_KEY,
  SETTINGS_AI_CLEAR_API_KEY,
  SETTINGS_AI_GET_STATUS,
  SETTINGS_AI_TEST_CONNECTION,
  ASSISTANT_ASK,
  ASSISTANT_RESET,
  ASSISTANT_LIST_CONVERSATIONS,
  ASSISTANT_OPEN_CONVERSATION,
} from '../shared/ipc';

function subscribe<T>(
  channel:
    | typeof SCAN_PROGRESS
    | typeof SCAN_FINISHED
    | typeof AI_RESULT_UPDATED
    | typeof QUARANTINE_CHANGED,
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
  quarantine: {
    list: (query) =>
      query === undefined
        ? ipcRenderer.invoke(QUARANTINE_LIST)
        : ipcRenderer.invoke(QUARANTINE_LIST, query),
    quarantine: (resultId) =>
      ipcRenderer.invoke(QUARANTINE_QUARANTINE, resultId),
    restore: (itemId, options) =>
      ipcRenderer.invoke(QUARANTINE_RESTORE, itemId, options),
    delete: (itemId) => ipcRenderer.invoke(QUARANTINE_DELETE, itemId),
    onChanged: (callback) =>
      subscribe<QuarantineChanged>(QUARANTINE_CHANGED, callback),
  },
  settings: {
    ai: {
      setApiKey: (key) => ipcRenderer.invoke(SETTINGS_AI_SET_API_KEY, key),
      clearApiKey: () => ipcRenderer.invoke(SETTINGS_AI_CLEAR_API_KEY),
      getStatus: () => ipcRenderer.invoke(SETTINGS_AI_GET_STATUS),
      testConnection: () => ipcRenderer.invoke(SETTINGS_AI_TEST_CONNECTION),
    },
  },
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
    getResult: (resultId) => ipcRenderer.invoke(SCAN_GET_RESULT, resultId),
    getJobSummary: (jobId) => ipcRenderer.invoke(SCAN_GET_JOB_SUMMARY, jobId),
    analyzeNow: (resultId) => ipcRenderer.invoke(SCAN_ANALYZE_NOW, resultId),
    onProgress: (callback) => subscribe<ScanProgress>(SCAN_PROGRESS, callback),
    onFinished: (callback) => subscribe<ScanJobDTO>(SCAN_FINISHED, callback),
    onResultUpdated: (callback) =>
      subscribe<AIResultUpdated>(AI_RESULT_UPDATED, callback),
  },
  system: {
    getStatus: (): Promise<SystemStatus> =>
      ipcRenderer.invoke(SYSTEM_GET_STATUS),
    reconnectEngine: (): Promise<SystemStatus> =>
      ipcRenderer.invoke(SYSTEM_RECONNECT_ENGINE),
  },
  assistant: {
    listConversations: (query) =>
      query === undefined
        ? ipcRenderer.invoke(ASSISTANT_LIST_CONVERSATIONS)
        : ipcRenderer.invoke(ASSISTANT_LIST_CONVERSATIONS, query),
    openConversation: (id) =>
      ipcRenderer.invoke(ASSISTANT_OPEN_CONVERSATION, id),
    ask: (query) => ipcRenderer.invoke(ASSISTANT_ASK, query),
    reset: () => ipcRenderer.invoke(ASSISTANT_RESET),
  },
};

contextBridge.exposeInMainWorld('cybersoc', api);
