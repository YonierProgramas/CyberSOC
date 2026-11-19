import { describe, expect, it, vi } from 'vitest';
import type {
  CyberSocApi,
  QuarantineItemDTO,
  ScanResultDTO,
} from '../../src/shared/ipc';
import {
  MAX_SECURITY_ALERTS,
  quarantineNotice,
  updateAlerts,
  watchSecurityAlerts,
} from '../../src/renderer/src/security/alerts';

function result(
  id = 'r1',
  verdict: ScanResultDTO['verdict'] = 'DETECTED',
): ScanResultDTO {
  return {
    id,
    jobId: 'job',
    seq: 0,
    path: 'C:/demo.txt',
    fileName: 'demo.txt',
    extension: '.txt',
    sizeBytes: 10,
    modifiedAt: null,
    status: 'SCANNED',
    sha256: 'a'.repeat(64),
    verdict,
    errorCode: null,
    errorMessage: null,
    durationMs: 1,
    scannedAt: '2026-11-19T12:00:00Z',
    engineScore: 85,
    riskLevel: 'CRÍTICO',
    aiStatus: 'NOT_REQUIRED',
    zone: 'OTRA',
  };
}

function item(
  status: QuarantineItemDTO['status'],
  resultId = 'r1',
): QuarantineItemDTO {
  return {
    id: 'q1',
    resultId,
    originalPath: 'C:/demo.txt',
    sha256: 'a'.repeat(64),
    sizeBytes: 10,
    reason: 'Prueba',
    verdictSnapshot: 'DETECTED',
    status,
    quarantinedAt: null,
    restoredAt: null,
    restoredTo: 'C:/demo.txt',
    deletedAt: null,
    errorMessage: null,
  };
}

describe('security alerts', () => {
  it('alerts for detected and suspicious files, ignores clean and unanalyzed files', () => {
    const threats = updateAlerts(
      [],
      [
        result('clean', 'CLEAN'),
        result('detected'),
        result('suspicious', 'SUSPICIOUS'),
        { ...result('failed'), status: 'ERROR' },
      ],
    );
    expect(threats.map((entry) => entry.id)).toEqual([
      'suspicious',
      'detected',
    ]);
    expect(updateAlerts(threats, [result('detected')])).toHaveLength(2);
    expect(updateAlerts(threats, [result('detected', 'CLEAN')])).toHaveLength(
      1,
    );
  });

  it('bounds visible alerts without confusing repeated paths with repeated results', () => {
    const results = Array.from(
      { length: MAX_SECURITY_ALERTS + 3 },
      (_, index) => result(String(index)),
    );
    const alerts = updateAlerts([], results);
    expect(alerts).toHaveLength(MAX_SECURITY_ALERTS);
    expect(alerts[0]?.id).toBe(String(MAX_SECURITY_ALERTS + 2));
    expect(alerts.at(-1)?.id).toBe('3');
  });

  it('only confirms isolation from a QUARANTINED record for this exact result', () => {
    expect(quarantineNotice(result(), null).text).toContain('sin confirmar');
    expect(quarantineNotice(result(), []).text).toContain('Sin cuarentena');
    expect(quarantineNotice(result(), [item('QUARANTINED')]).isolated).toBe(
      true,
    );
    expect(
      quarantineNotice(result(), [item('QUARANTINED', 'old-result')]).isolated,
    ).toBe(false);
    for (const status of [
      'PENDING',
      'FAILED',
      'RESTORED',
      'DELETED',
    ] as const) {
      expect(quarantineNotice(result(), [item(status)]).isolated).toBe(false);
    }
    expect(
      quarantineNotice(result(), [item('RESTORED'), item('QUARANTINED')])
        .isolated,
    ).toBe(true);
    expect(
      quarantineNotice(result(), [item('QUARANTINED'), item('FAILED')]).text,
    ).toContain('falló');
  });

  it('serializes progress bursts, reads every page and releases subscriptions', async () => {
    let progress!: Parameters<CyberSocApi['scan']['onProgress']>[0];
    let finish!: Parameters<CyberSocApi['scan']['onFinished']>[0];
    const stops = [vi.fn(), vi.fn(), vi.fn()];
    let resolvePage!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      resolvePage = resolve;
    });
    const listResults = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ items: [result('r2')], total: 2 })
      .mockResolvedValue({ items: [], total: 2 });
    const scan = {
      listResults,
      listJobs: vi.fn().mockResolvedValue([]),
      onProgress: (cb: typeof progress) => {
        progress = cb;
        return stops[0];
      },
      onFinished: (cb: typeof finish) => {
        finish = cb;
        return stops[1];
      },
      onResultUpdated: () => stops[2],
    } as unknown as CyberSocApi['scan'];
    const received = vi.fn();
    const failed = vi.fn();
    const stop = watchSecurityAlerts(scan, received, failed);
    progress({ jobId: 'job' } as Parameters<typeof progress>[0]);
    progress({ jobId: 'job' } as Parameters<typeof progress>[0]);
    finish({ id: 'job' } as Parameters<typeof finish>[0]);
    expect(listResults).toHaveBeenCalledTimes(1);
    resolvePage({ items: [result()], total: 2 });
    await vi.waitFor(() => expect(listResults).toHaveBeenCalledTimes(3));
    expect(listResults.mock.calls.map(([query]) => query.offset)).toEqual([
      0, 1, 2,
    ]);
    expect(received.mock.calls.slice(0, 2).map(([rows]) => rows[0].id)).toEqual(
      ['r1', 'r2'],
    );
    expect(failed).not.toHaveBeenCalled();
    stop();
    stops.forEach((unsubscribe) => expect(unsubscribe).toHaveBeenCalledOnce());
  });

  it('does not publish an in-flight response after unmount', async () => {
    let resolveJobs!: (jobs: unknown) => void;
    const jobs = new Promise((resolve) => {
      resolveJobs = resolve;
    });
    const scan = {
      listJobs: () => jobs,
      listResults: vi.fn(),
      onProgress: () => vi.fn(),
      onFinished: () => vi.fn(),
      onResultUpdated: () => vi.fn(),
    } as unknown as CyberSocApi['scan'];
    const received = vi.fn();
    const stop = watchSecurityAlerts(scan, received, vi.fn());
    stop();
    resolveJobs([{ id: 'job' }]);
    await jobs;
    expect(scan.listResults).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
  });
});
