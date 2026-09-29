import { contextBridge, ipcRenderer } from 'electron';
import {
  SYSTEM_GET_STATUS,
  type CyberSocApi,
  type SystemStatus,
} from '../shared/ipc';

const api: CyberSocApi = {
  system: {
    getStatus: (): Promise<SystemStatus> =>
      ipcRenderer.invoke(SYSTEM_GET_STATUS),
  },
};

contextBridge.exposeInMainWorld('cybersoc', api);
