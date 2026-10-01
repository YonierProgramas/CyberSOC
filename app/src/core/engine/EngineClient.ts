import type {
  EngineResult,
  ScanFileParams,
  DriveInfoResult,
  StatsResult,
} from '../../shared/protocol';

export interface EngineInfo {
  protocol: '1';
  engineVersion: string;
  python: string;
  capabilities: string[];
}

export interface EngineClient {
  driveInfo(path: string): Promise<DriveInfoResult>;
  stats(): Promise<StatsResult>;
  hello(): Promise<EngineInfo>;
  ping(): Promise<{ ts: string }>;
  shutdown(): Promise<void>;
  scanFile(params: ScanFileParams, timeoutMs: number): Promise<EngineResult>;
}

export class RpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Timeout de ${method} (${timeoutMs} ms).`);
  }
}

export class RpcRemoteError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class IncompatibleEngineError extends Error {
  constructor(
    public readonly protocol: string,
    public readonly engineVersion: string,
  ) {
    super(`Protocolo de motor incompatible: ${protocol}`);
  }
}
