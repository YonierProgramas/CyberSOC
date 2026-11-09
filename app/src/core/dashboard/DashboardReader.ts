import type { SQLInputValue } from 'node:sqlite';
import type { Database } from '../persistence/Database';
import { ScanJobRepository } from '../persistence/ScanJobRepository';
import type {
  DashboardOverviewDTO,
  DashboardOverviewQuery,
  VerdictDistributionDTO,
  ScanJobStatus,
} from '../../shared/ipc';
import {
  dashboardQuerySchema,
  dashboardOverviewSchema,
  jobStatusSchema,
  verdictSchema,
  resultStatusSchema,
  aiStatusSchema,
  quarantineStatusSchema,
} from '../../shared/history-schemas';
import {
  civilDayCount,
  localDateKey,
  localStart,
  localEndExclusive,
  shiftCivilDate,
} from './localDates';

const activeStates: ScanJobStatus[] = [
  'CREATED',
  'DISCOVERING',
  'SCANNING',
  'CANCELLING',
];
/** Dictionary: exactly one key per status, even at zero.
 * Build O(k), lookup/update O(1) average; k is the number of statuses.
 */
function zeros<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

/** SELECT only: totals are SQL aggregates of the history, never recent pages. */
export class DashboardReader {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getOverview(input: DashboardOverviewQuery = {}): DashboardOverviewDTO {
    const query = dashboardQuerySchema.parse(input);
    const now = this.now();
    const to = query.to ?? localDateKey(now);
    const from = query.from ?? shiftCivilDate(to, -6);
    const days = civilDayCount(from, to);
    if (!Number.isInteger(days) || days < 1 || days > 366)
      throw new RangeError('INVALID_RANGE');
    const range = { from, to };
    const rangeWhere = 'j.created_at >= ? AND j.created_at < ?';
    const rangeParameters = [localStart(from), localEndExclusive(to)];
    return this.db.readTransaction(() => {
      const byJobStatus = this.jobCounts('1', []);
      const jobs = Object.values(byJobStatus).reduce(
        (sum, value) => sum + value,
        0,
      );
      const allResults = Number(
        this.db.prepare('SELECT COUNT(*) total FROM scan_results').get()!.total,
      );
      const firstJobAt = this.db
        .prepare('SELECT MIN(created_at) first FROM scan_jobs')
        .get()!.first as string | null;
      const repo = new ScanJobRepository(this.db);
      const lastId = this.db
        .prepare(
          "SELECT id FROM scan_jobs WHERE status='COMPLETED' ORDER BY finished_at DESC, id DESC LIMIT 1",
        )
        .get()?.id as string | undefined;
      const last = lastId ? repo.get(lastId)! : null;
      const activeId = this.db
        .prepare(
          "SELECT id FROM scan_jobs WHERE status IN ('CREATED','DISCOVERING','SCANNING','CANCELLING') ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .get()?.id as string | undefined;
      const allCompleted = this.distribution(
        'ALL_COMPLETED',
        "j.status='COMPLETED'",
        [],
        ['COMPLETED'],
        null,
      );
      allCompleted.excluded = this.excluded("j.status <> 'COMPLETED'", []);
      const rangeDistribution = this.distribution(
        'RANGE',
        rangeWhere,
        rangeParameters,
        [...jobStatusSchema.options],
        range,
      );
      const lastCompleted = last
        ? {
            ...this.distribution(
              'LAST_COMPLETED',
              'j.id = ?',
              [last.id],
              ['COMPLETED'],
              null,
            ),
            job: last,
            excluded: this.excluded(
              "j.status IN ('FAILED','CANCELLED') AND j.finished_at > ?",
              [last.finishedAt],
            ),
          }
        : null;
      const daily: DashboardOverviewDTO['activity']['daily'] = [];
      // Map: one cell per calendar day in the range. get/set O(1) average;
      // build/walk O(d), O(d) memory, d ≤ 366. It stores no individual results.
      const dayMap = new Map<
        string,
        DashboardOverviewDTO['activity']['daily'][number]
      >();
      for (let index = 0; index < days; index++) {
        const cell = {
          date: shiftCivilDate(from, index),
          jobs: 0,
          results: 0,
          detected: 0,
          suspicious: 0,
          errors: 0,
        };
        daily.push(cell);
        dayMap.set(cell.date, cell);
      }
      const rows = this.db
        .prepare(
          `SELECT j.created_at, COUNT(r.id) results,
        COALESCE(SUM(r.verdict='DETECTED'),0) detected,
        COALESCE(SUM(r.verdict='SUSPICIOUS'),0) suspicious,
        COALESCE(SUM(r.status='ERROR'),0) errors
        FROM scan_jobs j LEFT JOIN scan_results r ON r.job_id=j.id
        WHERE ${rangeWhere} GROUP BY j.id`,
        )
        .all(...rangeParameters);
      for (const row of rows) {
        const cell = dayMap.get(localDateKey(new Date(String(row.created_at))));
        if (!cell) throw new Error('Fecha fuera de rango.');
        cell.jobs++;
        cell.results += Number(row.results);
        cell.detected += Number(row.detected);
        cell.suspicious += Number(row.suspicious);
        cell.errors += Number(row.errors);
      }
      const quarantine = zeros(quarantineStatusSchema.options);
      for (const row of this.db
        .prepare(
          'SELECT status, COUNT(*) total FROM quarantine_items GROUP BY status',
        )
        .all())
        quarantine[quarantineStatusSchema.parse(row.status)] = Number(
          row.total,
        );
      return dashboardOverviewSchema.parse({
        schema: 'cybersoc.dashboard/v1',
        generatedAt: now.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        range: { ...range, days },
        activity: {
          jobs: {
            total: rangeDistribution.jobs,
            byStatus: this.jobCounts(rangeWhere, rangeParameters),
          },
          daily,
        },
        distributions: {
          lastCompleted,
          allCompleted,
          range: rangeDistribution,
        },
        active: activeId ? repo.get(activeId)! : null,
        quarantine,
        allTime: { jobs, results: allResults, firstJobAt, byJobStatus },
      });
    });
  }

  private jobCounts(
    where: string,
    parameters: SQLInputValue[],
  ): Record<ScanJobStatus, number> {
    const counts = zeros(jobStatusSchema.options);
    for (const row of this.db
      .prepare(
        `SELECT j.status, COUNT(*) total FROM scan_jobs j WHERE ${where} GROUP BY j.status`,
      )
      .all(...parameters))
      counts[jobStatusSchema.parse(row.status)] = Number(row.total);
    return counts;
  }

  private excluded(
    where: string,
    parameters: SQLInputValue[],
  ): VerdictDistributionDTO['excluded'] {
    const byJobStatus = this.jobCounts(where, parameters);
    return {
      jobs: Object.values(byJobStatus).reduce((sum, value) => sum + value, 0),
      byJobStatus,
      results: Number(
        this.db
          .prepare(
            `SELECT COUNT(*) total FROM scan_jobs j CROSS JOIN scan_results r INDEXED BY idx_results_job WHERE r.job_id=j.id AND ${where}`,
          )
          .get(...parameters)!.total,
      ),
    };
  }

  private distribution(
    scope: VerdictDistributionDTO['scope'],
    where: string,
    parameters: SQLInputValue[],
    jobStatuses: ScanJobStatus[],
    range: VerdictDistributionDTO['range'],
  ): VerdictDistributionDTO {
    const byVerdict = zeros(verdictSchema.options);
    const byStatus = zeros(resultStatusSchema.options);
    const byAiStatus = zeros(aiStatusSchema.options);
    let total = 0;
    // Profiling showed that grouping by zone chose to walk ALL results
    // via idx_results_zone even on a small range. Filtering jobs first
    // and using the existing job index avoids that walk, with no new index/DDL.
    const grouped = this.db
      .prepare(
        `SELECT r.verdict, r.status, r.ai_status, COUNT(*) total
      FROM scan_jobs j CROSS JOIN scan_results r INDEXED BY idx_results_job WHERE r.job_id=j.id AND ${where}
      GROUP BY r.verdict, r.status, r.ai_status`,
      )
      .all(...parameters);
    for (const row of grouped) {
      const count = Number(row.total);
      total += count;
      byVerdict[verdictSchema.parse(row.verdict)] += count;
      byStatus[resultStatusSchema.parse(row.status)] += count;
      byAiStatus[aiStatusSchema.parse(row.ai_status)] += count;
    }
    const byZone = this.db
      .prepare(
        `SELECT r.zone, COUNT(*) results FROM scan_jobs j
      CROSS JOIN scan_results r INDEXED BY idx_results_job WHERE r.job_id=j.id AND ${where} GROUP BY r.zone
      ORDER BY results DESC, r.zone ASC`,
      )
      .all(
        ...parameters,
      ) as unknown as VerdictDistributionDTO['results']['byZone'];
    const jobs = this.jobCounts(where, parameters);
    return {
      scope,
      jobStatuses,
      range,
      jobs: Object.values(jobs).reduce((sum, value) => sum + value, 0),
      results: { total, byVerdict, byStatus, byZone, byAiStatus },
      excluded: {
        jobs: 0,
        results: 0,
        byJobStatus: zeros(jobStatusSchema.options),
      },
      partial: activeStates.some((status) => jobs[status] > 0),
    };
  }
}
