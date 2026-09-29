import type { CyberSocApi } from '../../shared/ipc';

declare global {
  interface Window {
    readonly cybersoc: CyberSocApi;
  }
}
