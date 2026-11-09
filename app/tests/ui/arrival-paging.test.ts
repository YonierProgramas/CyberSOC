import { describe, expect, it } from 'vitest';
import {
  archiveOffsetAfterReopen,
  offsetAfterArrival,
  shouldProbeArrival,
} from '../../src/renderer/src/paging/arrival';

describe('history: addition versus update', () => {
  it('a new analysis entering the filter returns to page 1', () => {
    expect(
      shouldProbeArrival({ matched: false, seen: false, finished: false }),
    ).toBe(true);
    expect(offsetAfterArrival(20, true)).toBe(0);
  });

  it('a new analysis excluded by the filter keeps the page', () => {
    expect(offsetAfterArrival(20, false)).toBe(20);
  });

  it('updating an already listed analysis does not query the first page again', () => {
    expect(
      shouldProbeArrival({ matched: true, seen: true, finished: true }),
    ).toBe(false);
    expect(
      shouldProbeArrival({ matched: true, seen: true, finished: false }),
    ).toBe(false);
  });

  it('an intermediate notice of an already seen id is not an addition', () => {
    expect(
      shouldProbeArrival({ matched: false, seen: true, finished: false }),
    ).toBe(false);
  });

  it('on finish, an id that earlier did not match the filter is checked', () => {
    expect(
      shouldProbeArrival({ matched: false, seen: true, finished: true }),
    ).toBe(true);
    expect(offsetAfterArrival(20, true)).toBe(0);
  });
});

describe('archive: reopening without an addition keeps the page', () => {
  it('the first read does not treat the existing total as an addition', () => {
    expect(
      archiveOffsetAfterReopen({
        offset: 0,
        previousTotal: 0,
        nextTotal: 49,
        hasBaseline: false,
      }),
    ).toBe(0);
  });

  it('reopening with the same total keeps 21–40', () => {
    expect(
      archiveOffsetAfterReopen({
        offset: 20,
        previousTotal: 49,
        nextTotal: 49,
        hasBaseline: true,
      }),
    ).toBe(20);
  });

  it('a new conversation, from 49 to 50, returns to page 1', () => {
    expect(
      archiveOffsetAfterReopen({
        offset: 20,
        previousTotal: 49,
        nextTotal: 50,
        hasBaseline: true,
      }),
    ).toBe(0);
  });
});
