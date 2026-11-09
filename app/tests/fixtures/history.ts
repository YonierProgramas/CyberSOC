import type { Database } from '../../src/core/persistence/Database';
import { ScanJobRepository } from '../../src/core/persistence/ScanJobRepository';
import { ConversationRepository } from '../../src/core/persistence/ConversationRepository';
import {
  jobStatusSchema,
  aiStatusSchema,
} from '../../src/shared/history-schemas';
import {
  ASSISTANT_CARD_SCHEMA_V1,
  type AssistantCardV1,
} from '../../src/shared/ipc';

export function emptyCard(): AssistantCardV1 {
  return {
    schema: ASSISTANT_CARD_SCHEMA_V1,
    focus: { kind: 'NONE', id: null, label: null },
    references: [],
    suggestedActions: [],
    report: null,
    scanPlan: null,
  };
}

/** Deterministic fixture: synthetic SQL rows, never user files or malware.
 * Manifest array: one entry per job; amortized O(1) push, O(j) walk.
 */
export function seedHistory(db: Database, jobs = 250, results = 30_000) {
  const manifest: {
    id: string;
    status: (typeof jobStatusSchema.options)[number];
    createdAt: string;
    results: number;
  }[] = [];
  const repo = new ScanJobRepository(db);
  const insert = db.prepare(`INSERT INTO scan_results
    (id, job_id, seq, path, file_name, status, verdict, scanned_at, ai_status, zone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const zones = [
    'DESCARGAS',
    'ESCRITORIO',
    'DOCUMENTOS',
    'TEMPORALES',
    'DATOS_APPS',
    'EXTRAIBLE',
    'PROGRAMAS',
    'SISTEMA',
    'OTRA',
    null,
  ];
  let serial = 0;
  db.transaction(() => {
    for (let index = 0; index < jobs; index++) {
      const date = new Date('2026-11-04T17:00:00.000Z');
      date.setUTCDate(
        date.getUTCDate() - 400 + Math.floor((index * 400) / (jobs - 1)),
      );
      const createdAt = date.toISOString();
      const id = `history-${String(index).padStart(5, '0')}`;
      const status =
        index === 0
          ? 'COMPLETED'
          : index === 1
            ? 'FAILED'
            : index === 2 || index === jobs - 1
              ? 'SCANNING'
              : jobStatusSchema.options[index % 7]!;
      repo.create({
        id,
        targetKind: 'FOLDER',
        targetPath: 'C:\\Sintetico\\historial',
        createdAt,
      });
      repo.updateStatus(id, status, {
        startedAt: createdAt,
        ...(status === 'COMPLETED' ||
        status === 'FAILED' ||
        status === 'CANCELLED'
          ? { finishedAt: new Date(date.getTime() + 1000).toISOString() }
          : {}),
      });
      let size = Math.floor(results / jobs);
      if (jobs === 250 && results === 30_000) {
        if (index === 1) size = 30;
        if (index === 2) size = 90;
        if (index === 5) size = 240;
      }
      if (index === jobs - 1) size = results - serial;
      for (let seq = 0; seq < size; seq++) {
        const state =
          serial % 17 === 0
            ? 'ERROR'
            : serial % 19 === 0
              ? 'SKIPPED'
              : 'SCANNED';
        const verdict =
          state !== 'SCANNED'
            ? 'NOT_ANALYZED'
            : ['NOT_EVALUATED', 'CLEAN', 'SUSPICIOUS', 'DETECTED'][serial % 4]!;
        insert.run(
          `synthetic-${serial}`,
          id,
          seq,
          'C:\\Sintetico\\mismo.txt',
          'mismo.txt',
          state,
          verdict,
          createdAt,
          aiStatusSchema.options[serial % 8]!,
          zones[serial % 10]!,
        );
        serial++;
      }
      manifest.push({ id, status, createdAt, results: size });
    }
  });
  return manifest;
}

export function seedMessages(db: Database, count = 250): string {
  const repo = new ConversationRepository(db);
  const id = repo.create('Solo datos sintéticos').id;
  db.transaction(() => {
    for (let index = 0; index < count; index++) {
      if (index % 3 === 0)
        repo.append(id, [{ role: 'user', content: `Pregunta ${index}` }]);
      else if (index % 3 === 1)
        repo.append(id, [
          {
            role: 'tool',
            content: 'Esta cadena privada nunca debe salir',
            toolCallsJson: JSON.stringify([
              {
                name: 'list_scans',
                input: {
                  path: 'C:\\PRIVADO-SINTETICO',
                  hash: 'secreto-de-fixture',
                },
                ok: true,
              },
            ]),
          },
        ]);
      else
        repo.appendAnsweredWithCard(
          id,
          { content: `Respuesta ${index}`, model: 'fake-history' },
          emptyCard(),
        );
    }
  });
  return id;
}

/** Valid card of exact size, using escaped controls and bounded paths. */
export function cardAtBytes(target: number): AssistantCardV1 {
  const card = emptyCard();
  card.focus.label = '';
  card.scanPlan = {
    schema: 'cybersoc.scan-plan/v1',
    targets: Array.from({ length: 10 }, () => ({
      zoneId: 'DESCARGAS',
      driveId: null,
      paths: Array.from({ length: 20 }, () => ''),
    })),
    profile: {
      layers: ['HASH', 'SIGNATURES'],
      includeHidden: false,
      maxFileSizeMB: 10,
    },
    rationale: '',
    layerRationale: [],
  };
  let remaining = target - Buffer.byteLength(JSON.stringify(card));
  for (const zone of card.scanPlan.targets)
    for (let index = 0; index < zone.paths.length; index++) {
      const length = Math.min(1024, Math.floor(remaining / 6));
      zone.paths[index] = '\u0001'.repeat(length);
      remaining -= length * 6;
    }
  if (remaining < 0 || remaining > 32767)
    throw new Error('Tamaño no representable en este fixture.');
  card.focus.label = 'x'.repeat(remaining);
  if (Buffer.byteLength(JSON.stringify(card)) !== target)
    throw new Error('Tamaño incorrecto.');
  return card;
}
