import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { vi } from 'vitest';
import { Database } from '../../src/core/persistence/Database';
import { MigrationRunner } from '../../src/core/persistence/MigrationRunner';
import { ScanJobRepository } from '../../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../../src/core/persistence/ScanResultRepository';
import type { QuarantineRecord } from '../../src/core/persistence/QuarantineRepository';
import {
  QuarantineManager,
  type Confirmation,
} from '../../src/core/quarantine/QuarantineManager';
import { QuarantineVault } from '../../src/core/quarantine/QuarantineVault';
import { ProtectedPaths, exists } from '../../src/core/quarantine/paths';
import { decideRisk } from '../../src/core/risk/RiskPolicy';

export const sha = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

/** Texto inofensivo de prueba. Nunca EICAR ni malware. */
export const HARMLESS = 'Texto inofensivo para pruebas adversariales.\n';

export interface Seeded {
  id: string;
  path: string;
  hash: string;
  data: Buffer;
}

/**
 * Escenario aislado: carpeta temporal propia, SQLite con migraciones, bóveda dentro de
 * la carpeta y gestor real. Las rutas protegidas extra son `protected/` y la bóveda.
 * Todo ataque apunta DENTRO de `root`: si una defensa fallara, solo se escribiría ahí.
 */
export class QuarantineHarness {
  root = '';
  db!: Database;
  vault!: QuarantineVault;
  manager!: QuarantineManager;
  confirm = vi.fn<(request: Confirmation) => Promise<boolean>>(
    async () => true,
  );
  private seq = 0;

  async setup(): Promise<void> {
    this.root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), 'cybersoc-adversarial-')),
    );
    this.db = new Database(join(this.root, 'test.db'));
    new MigrationRunner(this.db).run();
    new ScanJobRepository(this.db).create({
      id: 'job',
      targetPath: this.root,
      targetKind: 'FOLDER',
    });
    this.vault = new QuarantineVault(join(this.root, 'vault'));
    this.confirm = vi.fn(async () => true);
    this.manager = this.makeManager();
  }

  protectedPaths(): ProtectedPaths {
    return new ProtectedPaths([join(this.root, 'protected'), this.vault.root]);
  }

  /** Un gestor nuevo sobre la misma BD y bóveda: equivale a reiniciar la app. */
  makeManager(vault = this.vault): QuarantineManager {
    return new QuarantineManager({
      database: this.db,
      vault,
      confirm: this.confirm,
      protectedPaths: this.protectedPaths(),
    });
  }

  /** Crea el archivo y su resultado DETECTED, como si lo hubiera escaneado el motor. */
  async seed(
    name = `muestra-${this.seq}.txt`,
    data: string | Buffer = HARMLESS,
    resultPath?: string,
  ): Promise<Seeded> {
    const path = join(this.root, name);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, data);
    const buffer = Buffer.from(data);
    const id = `result-${this.seq++}`;
    const decision = decideRisk({ verdict: 'DETECTED', score: 100 });
    new ScanResultRepository(this.db).insertComplete({
      result: {
        id,
        jobId: 'job',
        seq: this.seq,
        path: resultPath ?? path,
        fileName: basename(path),
        status: 'SCANNED',
        sha256: sha(buffer),
        sizeBytes: buffer.length,
      },
      evidence: [],
      layers: [],
      assessment: {
        engineVerdict: decision.engineVerdict,
        engineScore: decision.engineScore,
        finalVerdict: decision.finalVerdict,
        finalLevel: decision.finalLevel,
        reviewRequired: decision.reviewRequired,
        origin: decision.origin,
        policyVersion: decision.policyVersion,
        traceJson: JSON.stringify(decision.trace),
      },
    });
    return { id, path, hash: sha(buffer), data: buffer };
  }

  record(id: string): QuarantineRecord {
    return this.manager.repository.get(id)!;
  }

  /** Archivos de la bóveda (blobs y temporales). */
  async vaultFiles(): Promise<string[]> {
    return (await exists(this.vault.root))
      ? (await fs.readdir(this.vault.root)).sort()
      : [];
  }

  /** Temporales de restauración en texto plano que hayan quedado en `dir`. */
  async restoreTemps(dir = this.root): Promise<string[]> {
    return (await fs.readdir(dir)).filter((name) =>
      name.startsWith('.cybersoc-restore-'),
    );
  }

  /** Cambia columnas que el repositorio no actualiza (clave, IV, hash…): simula una BD manipulada. */
  tamper(id: string, column: string, value: string | number | null): void {
    this.db
      .prepare(`UPDATE quarantine_items SET ${column} = ? WHERE id = ?`)
      .run(value, id);
  }

  async close(): Promise<void> {
    vi.restoreAllMocks();
    await this.manager.close();
    this.db.close();
    // Solo la carpeta creada por esta prueba; nunca archivos del usuario.
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
