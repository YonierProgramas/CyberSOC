import { contextBridge, ipcRenderer } from 'electron';
import {
  SYSTEM_GET_STATUS,
  SYSTEM_RECONNECT_ENGINE,
  type CyberSocApi,
  type SystemStatus,
} from '../shared/ipc';

const api: CyberSocApi = {
  system: {
    getStatus: (): Promise<SystemStatus> =>
      ipcRenderer.invoke(SYSTEM_GET_STATUS),
    reconnectEngine: (): Promise<SystemStatus> =>
      ipcRenderer.invoke(SYSTEM_RECONNECT_ENGINE),
  },
};

contextBridge.exposeInMainWorld('cybersoc', api);
