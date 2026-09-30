export const SYSTEM_GET_STATUS = 'system:getStatus';
export const SYSTEM_RECONNECT_ENGINE = 'system:reconnectEngine';

export type EngineState =
  | { status: 'connected'; engineVersion: string; protocol: '1' }
  | { status: 'disconnected'; engineVersion: null; protocol: null }
  | {
      status: 'incompatible';
      engineVersion: string | null;
      protocol: string | null;
    };

export interface SystemStatus {
  app: 'CyberSOC Defender';
  version: string;
  engine: EngineState;
}

export interface CyberSocApi {
  readonly system: {
    readonly getStatus: () => Promise<SystemStatus>;
    readonly reconnectEngine: () => Promise<SystemStatus>;
  };
}
