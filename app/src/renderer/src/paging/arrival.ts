/**
 * Decides whether a scan notice can be a new analysis.
 * An id already shown under the current filter is an update: the first page
 * is not queried again. An id never seen, or one that did not yet match the
 * filter and just finished, is checked.
 */
export function shouldProbeArrival(input: {
  matched: boolean;
  seen: boolean;
  finished: boolean;
}): boolean {
  if (input.matched) return false;
  return !input.seen || input.finished;
}

/**
 * Page 1 is only shown if the addition appears in the filtered query.
 * If the filter excludes it, the reader keeps the offset.
 */
export function offsetAfterArrival(
  offset: number,
  appearsOnFirstPage: boolean,
): number {
  return appearsOnFirstPage ? 0 : offset;
}

/**
 * Reopening the archive keeps the page until the total grows.
 * The first read has no baseline: a total above zero is not an addition.
 * An existing conversation that changes date does not increase the total.
 */
export function archiveOffsetAfterReopen(input: {
  offset: number;
  previousTotal: number;
  nextTotal: number;
  hasBaseline: boolean;
}): number {
  if (input.hasBaseline && input.nextTotal > input.previousTotal) return 0;
  return input.offset;
}
