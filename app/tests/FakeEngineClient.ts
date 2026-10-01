import type { EngineResult, ScanFileParams } from '../src/shared/protocol';
import type { EngineState } from '../src/shared/ipc';
import type { ScanEngine } from '../src/core/scan/ScanOrchestrator';

export function scanned(params: ScanFileParams): EngineResult {
  return {
    taskId: params.taskId,
    status: 'SCANNED',
    evidence: [],
    layers: [],
    durationMs: 1,
    engineVersion: '0.1.0',
    file: {
      name: params.path.split(/[\\/]/).pop()!,
      extension: '.txt',
      sizeBytes: 3,
      modifiedAt: '2026-09-30T00:00:00Z',
    },
    hashes: { sha256: 'a'.repeat(64) },
  };
}

export class FakeEngineClient implements ScanEngine {
  readonly calls: { params: ScanFileParams; timeoutMs: number }[] = [];
  readonly responses: Array<(params: ScanFileParams) => Promise<EngineResult>> =
    [];
  restarts = 0;
  state: EngineState = {
    status: 'connected',
    engineVersion: '0.1.0',
    protocol: '1',
  };
  onRestart?: () => Promise<EngineState>;

  getState(): EngineState {
    return { ...this.state };
  }
  async scanFile(
    params: ScanFileParams,
    timeoutMs: number,
  ): Promise<EngineResult> {
    this.calls.push({ params, timeoutMs });
    const reply = this.responses.shift();
    return reply ? reply(params) : scanned(params);
  }
  async reconnect(): Promise<EngineState> {
    this.restarts += 1;
    if (this.onRestart) this.state = await this.onRestart();
    return this.getState();
  }
  async ping(): Promise<{ ts: string }> {
    return { ts: new Date().toISOString() };
  }
  async driveInfo() {
    return { driveType: 'FIXED' as const };
  }
  async stats() {
    return {
      engineVersion: '0.1.0',
      rulesetVersion: 'test-rules',
      signaturesVersion: 'test-signatures',
      signaturesCount: 5,
    };
  }
}
