import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigSchema } from '../src/core/config/AppConfig';
import { ScanQueue } from '../src/core/scan/ScanQueue';
import { ProgressThrottle } from '../src/core/scan/ProgressThrottle';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const config = appConfigSchema.parse({ scan: { queueCapacity: 2 } });

describe('ScanQueue', () => {
  it('respeta capacidad 2, FIFO y mide el tiempo bloqueado del productor', async () => {
    const queue = new ScanQueue<number>(config);
    await queue.put(1);
    await queue.put(2);
    let accepted = false;
    const put = queue.put(3).then(() => {
      accepted = true;
    });
    await vi.advanceTimersByTimeAsync(75);
    expect(accepted).toBe(false);
    expect(queue.size).toBe(2);
    expect(queue.peakSize).toBe(2);
    expect(queue.producerBlockedMs).toBe(75);
    expect(await queue.take()).toBe(1);
    await put;
    expect(await queue.take()).toBe(2);
    expect(await queue.take()).toBe(3);
    expect(queue.producerBlockedMs).toBe(75);
    expect(queue.peakSize).toBe(2);
  });

  it('take espera y close permite consumir pendientes antes del fin', async () => {
    const queue = new ScanQueue<number>(config);
    const waiting = queue.take();
    await queue.put(7);
    expect(await waiting).toBe(7);
    await queue.put(8);
    queue.close();
    queue.close();
    expect(await queue.take()).toBe(8);
    expect(await queue.take()).toBeUndefined();
    await expect(queue.put(9)).rejects.toThrow('cerrada');
  });

  it('close libera productores y consumidores bloqueados sin perder promesas', async () => {
    const full = new ScanQueue<number>(config);
    await full.put(1);
    await full.put(2);
    const checks = [
      expect(full.put(3)).rejects.toThrow('cerrada'),
      expect(full.put(4)).rejects.toThrow('cerrada'),
    ];
    full.close();
    expect(full.drain()).toEqual([1, 2]);
    await Promise.all(checks);
    const empty = new ScanQueue<number>(config);
    const takes = [empty.take(), empty.take()];
    empty.close();
    expect(await Promise.all(takes)).toEqual([undefined, undefined]);
  });

  it('drain vacía la cola y desbloquea un put si sigue abierta', async () => {
    const queue = new ScanQueue<number>(config);
    await queue.put(1);
    await queue.put(2);
    const pending = queue.put(3);
    expect(queue.drain()).toEqual([1, 2]);
    await pending;
    expect(queue.drain()).toEqual([3]);
    expect(queue.drain()).toEqual([]);
  });

  it('AbortSignal libera una espera y no encola el elemento cancelado', async () => {
    const queue = new ScanQueue<number>(config);
    await queue.put(1);
    await queue.put(2);
    const controller = new AbortController();
    const put = expect(queue.put(3, controller.signal)).rejects.toThrow(
      'cancelado',
    );
    controller.abort(new Error('cancelado'));
    await put;
    expect(queue.drain()).toEqual([1, 2]);
    const taker = new AbortController();
    const take = expect(queue.take(taker.signal)).rejects.toThrow('cancelado');
    taker.abort(new Error('cancelado'));
    await take;
    await expect(queue.put(4, taker.signal)).rejects.toThrow('cancelado');
    await queue.put(5);
    expect(await queue.take()).toBe(5);
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    'rechaza capacidad %s',
    (queueCapacity) => {
      expect(
        () => new ScanQueue({ scan: { ...config.scan, queueCapacity } }),
      ).toThrow(RangeError);
    },
  );
});

describe('ProgressThrottle', () => {
  it('agrupa ráfagas, entrega el valor más reciente y flush mantiene 200 ms', async () => {
    const events: { value: number; at: number }[] = [];
    const throttle = new ProgressThrottle<number>((value) =>
      events.push({ value, at: performance.now() }),
    );
    throttle.push(0);
    for (let i = 1; i <= 19; i++) {
      await vi.advanceTimersByTimeAsync(10);
      throttle.push(i);
    }
    let flushed = false;
    const finish = throttle.flush().then(() => {
      flushed = true;
    });
    expect(flushed).toBe(false);
    expect(events).toEqual([{ value: 0, at: 0 }]);
    await vi.advanceTimersByTimeAsync(10);
    await finish;
    expect(events).toEqual([
      { value: 0, at: 0 },
      { value: 19, at: 200 },
    ]);
    await throttle.flush();
    throttle.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose cancela la entrega pendiente y resuelve flush sin eventos tardíos', async () => {
    const emit = vi.fn();
    const throttle = new ProgressThrottle(emit);
    throttle.push('first');
    throttle.push('pending');
    const flushed = throttle.flush();
    throttle.dispose();
    await flushed;
    throttle.push('late');
    await vi.advanceTimersByTimeAsync(500);
    expect(emit.mock.calls).toEqual([['first']]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
