export interface EngineInfo {
  protocol: '1';
  engineVersion: string;
  python: string;
  capabilities: string[];
}

export interface EngineClient {
  hello(): Promise<EngineInfo>;
  ping(): Promise<{ ts: string }>;
  shutdown(): Promise<void>;
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
