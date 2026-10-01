import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import {
  ScanJobRepository,
  type ScanJobRecord,
} from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { LayerTraceRepository } from '../src/core/persistence/LayerTraceRepository';
import { ScanProfiles } from '../src/core/zones/ScanProfiles';
import { ZoneClassifier } from '../src/core/zones/ZoneClassifier';
import { ScanOrchestrator } from '../src/core/scan/ScanOrchestrator';
import { appConfigSchema } from '../src/core/config/AppConfig';
import { scanTargetSchema } from '../src/main/ipc/scan-validation';
import { layerSchema, type DriveInfoResult } from '../src/shared/protocol';
import { FakeEngineClient, scanned } from './FakeEngineClient';

describe('T3.6: perfiles aplicados por archivo y persistencia', () => {
  const databases: Database[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });
  function setup(
    files = ['C:\\Windows\\a.txt'],
    driveType: DriveInfoResult['driveType'] = 'FIXED',
  ) {
    const database = new Database(':memory:');
    databases.push(database);
    new MigrationRunner(database).run();
    const jobs = new ScanJobRepository(database);
    const results = new ScanResultRepository(database);
    const profiles = new ScanProfiles(database);
    const engine = new FakeEngineClient();
    const hidden = vi.fn<(path: string) => Promise<boolean>>(async () => false);
    const close = vi.fn();
    const orchestrator = new ScanOrchestrator({
      config: () => appConfigSchema.parse({}),
      engine,
      profiles,
      jobs,
      results,
      stats: () => engine.stats(),
      createZoneSession: () => {
        const classifier = new ZoneClassifier(
          [
            { path: 'C:\\Windows', zone: 'SISTEMA' },
            { path: 'C:\\Local', zone: 'DATOS_APPS' },
            { path: 'C:\\Local\\Temp', zone: 'TEMPORALES' },
          ],
          async () => ({ driveType }),
        );
        return {
          classify: (path) => classifier.classify(path),
          isHidden: hidden,
          close,
        };
      },
      createDiscovery: () => ({
        peakStackSize: 1,
        dirsVisited: 1,
        skippedLinks: 0,
        async *discover() {
          for (const path of files) yield { path };
        },
      }),
      sizeOf: async () => 3,
      persistResult(record, result) {
        database.transaction(() => {
          results.insertResult(record);
          new LayerTraceRepository(database).insertTrace(
            record.id,
            result.layers,
          );
        });
      },
    });
    const done = () =>
      new Promise<ScanJobRecord>((resolve) =>
        orchestrator.once('finished', resolve),
      );
    return {
      database,
      jobs,
      results,
      profiles,
      engine,
      hidden,
      close,
      orchestrator,
      done,
    };
  }

  it('SISTEMA envía el perfil y conserva HEURISTICS/PE/SCRIPTS DISABLED (motor simulado de 7 capas)', async () => {
    const t = setup();
    t.engine.responses.push(async (params) => ({
      ...scanned(params),
      // Simulador explícito del contrato futuro T3.4; no inventa capas en producción.
      layers: layerSchema.options.map((layer) =>
        params.options.layers!.includes(layer)
          ? { layer, status: 'RAN' as const, hits: 0, points: 0, ms: 1 }
          : {
              layer,
              status: 'DISABLED' as const,
              reason: 'PROFILE_DISABLED',
              hits: 0,
              points: 0,
              ms: 0,
            },
      ),
    }));
    const done = t.done();
    const id = t.orchestrator.start({
      kind: 'FOLDER',
      path: 'C:\\Windows',
      profile: 'AUTO',
    });
    expect((await done).status).toBe('COMPLETED');
    expect(t.engine.calls[0]!.params.options).toEqual({
      zone: 'SISTEMA',
      layers: ['HASH', 'SIGNATURES', 'FILETYPE'],
      maxBytes: 268435456,
    });
    const result = t.results.listByJob(id, 0, 20)[0]!;
    expect(result.zone).toBe('SISTEMA');
    const layers = new LayerTraceRepository(t.database).listByResult(result.id);
    for (const layer of ['HEURISTICS', 'PE', 'SCRIPTS'])
      expect(layers.find((item) => item.layer === layer)).toMatchObject({
        status: 'DISABLED',
        reason: 'PROFILE_DISABLED',
        hits: 0,
        points: 0,
      });
    expect(t.jobs.get(id)).toMatchObject({
      rulesetVersion: 'test-rules',
      signaturesVersion: 'test-signatures',
    });
    expect(JSON.parse(t.jobs.get(id)!.profileJson!)).toMatchObject({
      mode: 'AUTO',
      profiles: { SISTEMA: { layers: ['HASH', 'SIGNATURES', 'FILETYPE'] } },
    });
    expect(t.close).toHaveBeenCalledOnce();
  });
  it('TEMP dentro de LOCALAPPDATA incluye ocultos sin heredar el perfil del padre', async () => {
    const t = setup(['C:\\Local\\a.txt', 'C:\\Local\\Temp\\b.txt']);
    t.hidden.mockResolvedValue(true);
    const done = t.done();
    const id = t.orchestrator.start({ kind: 'FOLDER', path: 'C:\\Local' });
    await done;
    expect(t.engine.calls.map((c) => c.params.options.zone)).toEqual([
      'TEMPORALES',
    ]);
    expect(t.engine.calls[0]!.params.options.maxBytes).toBe(536870912);
    expect(t.results.listByJob(id, 0, 10).map((r) => r.zone)).toEqual([
      'TEMPORALES',
    ]);
  });
  it('EXTRAIBLE usa todas las capas, 512 MB e incluye ocultos', async () => {
    const t = setup(['E:\\a.txt'], 'REMOVABLE');
    t.hidden.mockResolvedValue(true);
    const done = t.done();
    t.orchestrator.start({ kind: 'FILE', path: 'E:\\a.txt' });
    await done;
    expect(t.engine.calls[0]!.params.options).toEqual({
      zone: 'EXTRAIBLE',
      layers: layerSchema.options,
      maxBytes: 536870912,
    });
    expect(t.hidden).not.toHaveBeenCalled();
  });
  it('perfil personalizado queda congelado y validado antes de crear un trabajo', async () => {
    const t = setup();
    const profile = {
      layers: ['HASH', 'SIGNATURES'] as ('HASH' | 'SIGNATURES')[],
      includeHidden: true,
      maxFileSizeMB: 8,
    };
    const input = scanTargetSchema.parse({
      kind: 'FILE',
      path: 'C:\\Windows\\a.txt',
      profile,
    });
    const done = t.done();
    const id = t.orchestrator.start(input);
    profile.layers.pop();
    profile.maxFileSizeMB = 1;
    t.profiles.set('SISTEMA', {
      layers: ['HASH', 'SIGNATURES'],
      includeHidden: false,
      maxFileSizeMB: 1,
    });
    await done;
    expect(t.engine.calls[0]!.params.options).toEqual({
      zone: 'SISTEMA',
      layers: ['HASH', 'SIGNATURES'],
      maxBytes: 8388608,
    });
    expect(JSON.parse(t.jobs.get(id)!.profileJson!)).toMatchObject({
      mode: 'CUSTOM',
      profile: { maxFileSizeMB: 8 },
    });
    expect(() =>
      scanTargetSchema.parse({ kind: 'FILE', path: 'C:\\a', profile }),
    ).toThrow();
    expect(() =>
      t.orchestrator.start({ kind: 'FILE', path: 'C:\\a', profile }),
    ).toThrow();
    expect(t.jobs.listRecent()).toHaveLength(1);
  });
  it('AUTO conserva sus perfiles aunque settings cambie durante el escaneo', async () => {
    const t = setup();
    const done = t.done();
    const id = t.orchestrator.start({ kind: 'FOLDER', path: 'C:\\Windows' });
    t.profiles.set('SISTEMA', {
      layers: ['HASH', 'SIGNATURES'],
      includeHidden: true,
      maxFileSizeMB: 1,
    });
    await done;
    expect(t.engine.calls[0]!.params.options.maxBytes).toBe(268435456);
    expect(
      JSON.parse(t.jobs.get(id)!.profileJson!).profiles.SISTEMA.maxFileSizeMB,
    ).toBe(256);
  });
  it('cancelar mientras se consultan versiones no deja el trabajo FAILED', async () => {
    const t = setup();
    t.engine.stats = () => new Promise(() => {});
    const done = t.done();
    const id = t.orchestrator.start({ kind: 'FOLDER', path: 'C:\\Windows' });
    await Promise.resolve();
    await t.orchestrator.cancel(id);
    expect((await done).status).toBe('CANCELLED');
    expect(t.engine.calls).toHaveLength(0);
    expect(t.close).toHaveBeenCalledOnce();
  });
  it('error de clasificación conserva el fallo y cierra la sesión', async () => {
    const t = setup(['ruta-relativa']);
    const done = t.done();
    t.orchestrator.start({ kind: 'FOLDER', path: 'C:\\Windows' });
    expect((await done).status).toBe('FAILED');
    expect(t.close).toHaveBeenCalledOnce();
  });
});
