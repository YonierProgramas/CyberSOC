import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ScanJob } from '../src/core/domain/ScanJob.ts';

const dates = [
  '2026-09-30T12:00:00.000Z',
  '2026-09-30T12:00:01.000Z',
  '2026-09-30T12:00:02.000Z',
  '2026-09-30T12:00:03.000Z',
];
const target = {
  id: 'job-1',
  targetPath: 'C:\\niño áéíóú 😀',
  targetKind: 'FOLDER',
};
const counters = {
  filesDiscovered: 5,
  filesProcessed: 4,
  filesError: 1,
  filesSkipped: 1,
  bytesProcessed: 300,
};
const zero = {
  filesDiscovered: 0,
  filesProcessed: 0,
  filesError: 0,
  filesSkipped: 0,
  bytesProcessed: 0,
};
const methods = [
  'beginDiscovery',
  'beginScanning',
  'requestCancel',
  'markCancelled',
  'complete',
  'fail',
];

// Approved transition table, independent from ScanJob's implementation.
const transitions = {
  CREATED: {
    beginDiscovery: 'DISCOVERING',
    requestCancel: 'CANCELLING',
    fail: 'FAILED',
  },
  DISCOVERING: {
    beginScanning: 'SCANNING',
    requestCancel: 'CANCELLING',
    fail: 'FAILED',
  },
  SCANNING: {
    requestCancel: 'CANCELLING',
    complete: 'COMPLETED',
    fail: 'FAILED',
  },
  CANCELLING: { markCancelled: 'CANCELLED', fail: 'FAILED' },
  CANCELLED: {},
  COMPLETED: {},
  FAILED: {},
};
const paths = {
  CREATED: [],
  DISCOVERING: ['beginDiscovery'],
  SCANNING: ['beginDiscovery', 'beginScanning'],
  CANCELLING: ['requestCancel'],
  CANCELLED: ['requestCancel', 'markCancelled'],
  COMPLETED: ['beginDiscovery', 'beginScanning', 'complete'],
  FAILED: ['fail'],
};

function atState(state, clock = () => dates[0]) {
  const job = new ScanJob(target, clock);
  for (const method of paths[state]) job[method]('fallo inicial');
  return job;
}

function snapshot(job) {
  return {
    status: job.status,
    counters: job.counters,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    errorMessage: job.errorMessage,
  };
}

describe('ScanJob: tabla completa de estados y métodos', () => {
  for (const [state, valid] of Object.entries(transitions)) {
    for (const method of methods) {
      const next = valid[method];
      it(`${state}.${method} → ${next ?? 'error'}`, () => {
        const job = atState(state);
        const before = snapshot(job);
        if (next) {
          job[method]('cuarto fallo del motor');
          assert.equal(job.status, next);
          assert.deepEqual(job.counters, before.counters);
          assert.equal(job.createdAt, before.createdAt);
          assert.equal(
            job.finishedAt,
            ['COMPLETED', 'CANCELLED', 'FAILED'].includes(next)
              ? dates[0]
              : null,
          );
          assert.equal(
            job.errorMessage,
            method === 'fail' ? 'cuarto fallo del motor' : null,
          );
        } else {
          assert.throws(() => job[method]('otro fallo'), /Transición inválida/);
          assert.deepEqual(snapshot(job), before);
        }
      });
    }
  }
});

describe('ScanJob: contadores y timestamps', () => {
  it('inicia en CREATED con identidad, contadores cero y reloj real por defecto', () => {
    const before = Date.now();
    const job = new ScanJob({ ...target, targetKind: 'FILE' });
    assert.equal(job.id, target.id);
    assert.equal(job.targetPath, target.targetPath);
    assert.equal(job.targetKind, 'FILE');
    assert.equal(job.status, 'CREATED');
    assert.deepEqual(job.counters, zero);
    assert.equal(job.startedAt, null);
    assert.equal(job.finishedAt, null);
    assert.equal(job.errorMessage, null);
    assert.ok(
      Date.parse(job.createdAt) >= before &&
        Date.parse(job.createdAt) <= Date.now(),
    );
  });

  it('conserva creación e inicio y registra el final al completar', () => {
    let tick = 0;
    const job = new ScanJob(target, () => dates[tick++]);
    job.beginDiscovery();
    assert.equal(job.startedAt, dates[1]);
    job.beginScanning();
    assert.equal(job.startedAt, dates[1]);
    assert.equal(job.finishedAt, null);
    job.complete();
    assert.equal(job.createdAt, dates[0]);
    assert.equal(job.startedAt, dates[1]);
    assert.equal(job.finishedAt, dates[3]);
  });

  it('permite cancelar antes de iniciar sin inventar startedAt', () => {
    let now = dates[0];
    const job = new ScanJob(target, () => now);
    now = dates[1];
    job.requestCancel();
    assert.equal(job.finishedAt, null);
    now = dates[2];
    job.markCancelled();
    assert.equal(job.createdAt, dates[0]);
    assert.equal(job.startedAt, null);
    assert.equal(job.finishedAt, dates[2]);
  });

  it('cuenta el archivo en curso durante CANCELLING y preserva datos al cancelar', () => {
    let now = dates[0];
    const job = new ScanJob(target, () => now);
    now = dates[1];
    job.beginDiscovery();
    job.beginScanning();
    job.requestCancel();
    job.updateCounters(counters);
    assert.equal(job.finishedAt, null);
    now = dates[3];
    job.markCancelled();
    assert.equal(job.startedAt, dates[1]);
    assert.equal(job.finishedAt, dates[3]);
    assert.deepEqual(job.counters, counters);
  });

  it('registra motivo y hora del fallo y conserva los contadores', () => {
    let now = dates[0];
    const job = new ScanJob(target, () => now);
    now = dates[1];
    job.beginDiscovery();
    job.updateCounters(counters);
    now = dates[2];
    job.fail('Motor desconectado');
    assert.equal(job.errorMessage, 'Motor desconectado');
    assert.equal(job.startedAt, dates[1]);
    assert.equal(job.finishedAt, dates[2]);
    assert.deepEqual(job.counters, counters);
  });

  it('rechaza un motivo vacío sin mutar la entidad', () => {
    const job = atState('SCANNING');
    const before = snapshot(job);
    assert.throws(() => job.fail('  '), /requiere un motivo/);
    assert.deepEqual(snapshot(job), before);
  });

  for (const state of ['CREATED', 'DISCOVERING', 'SCANNING', 'CANCELLING']) {
    it(`actualiza contadores absolutos en ${state} y aísla referencias externas`, () => {
      const job = atState(state);
      const input = { ...counters };
      job.updateCounters(input);
      job.updateCounters(input);
      input.filesProcessed = 99;
      const read = job.counters;
      read.filesProcessed = 100;
      assert.deepEqual(job.counters, counters);
      assert.equal(job.status, state);
    });
  }

  for (const state of ['COMPLETED', 'CANCELLED', 'FAILED']) {
    it(`no permite cambiar contadores después de ${state}`, () => {
      const job = atState(state);
      const before = snapshot(job);
      assert.throws(
        () => job.updateCounters(counters),
        /No se pueden actualizar/,
      );
      assert.deepEqual(snapshot(job), before);
    });
  }

  for (const field of Object.keys(counters)) {
    for (const invalid of [
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      it(`rechaza ${field}=${invalid} sin actualización parcial`, () => {
        const job = atState('SCANNING');
        job.updateCounters(counters);
        assert.throws(
          () => job.updateCounters({ ...zero, [field]: invalid }),
          RangeError,
        );
        assert.deepEqual(job.counters, counters);
      });
    }
  }

  it('no cambia estado ni fechas si falla el reloj', () => {
    let throws = false;
    const job = new ScanJob(target, () => {
      if (throws) throw new Error('clock failure');
      return dates[0];
    });
    throws = true;
    const before = snapshot(job);
    assert.throws(() => job.beginDiscovery(), /clock failure/);
    assert.deepEqual(snapshot(job), before);
  });
});
