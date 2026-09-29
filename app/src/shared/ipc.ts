export const SYSTEM_GET_STATUS = 'system:get-status';

export interface SystemStatus {
  app: 'CyberSOC Defender';
  version: string;
}

export interface CyberSocApi {
  readonly system: {
    readonly getStatus: () => Promise<SystemStatus>;
  };
}
