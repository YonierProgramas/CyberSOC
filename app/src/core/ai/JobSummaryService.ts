import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/AppConfig';
import type { AIStatus } from '../persistence/assessmentTypes';
import type { AIProvider, AIResult } from './AIProvider';
import type { AnalysisOutcome } from './AISecurityService';
import { buildJobSummaryContext } from './JobSummaryContext';
import type { JobSummaryStore } from './JobSummaryStore';
import { validateJobSummary } from './JobSummaryValidator';
import {
  JOB_SUMMARY_RETRY_MAX_TOKENS,
  PROMPT_VERSION,
  buildJobSummaryRequest,
} from './prompts/job-summary.v1';
import type { JobSummary } from './schemas';

/**
 * Resumen de escaneo por IA (`kind = JOB_SUMMARY`). Mismo ciclo que el análisis por archivo:
 * contexto → proveedor → validación → guardar el intento. Hasta dos intentos; el segundo lleva
 * la retroalimentación del validador o más tokens si el primero se cortó. Nunca cambia
 * veredictos: el resumen solo se guarda para mostrarlo.
 */
export class JobSummaryService {
  constructor(
    readonly store: JobSummaryStore,
    private readonly provider: () => AIProvider | null,
    private readonly readConfig: () => AppConfig,
  ) {}

  async summarize(
    jobId: string,
    signal?: AbortSignal,
    notify: (status: AIStatus) => void = () => {},
  ): Promise<AnalysisOutcome> {
    const config = this.readConfig();
    const built = buildJobSummaryContext(this.store.facts(jobId), {
      sendFileNames: config.ai.sendFileNames,
    });
    this.store.setStatus(jobId, 'RUNNING');
    notify('RUNNING');
    let previousErrors: string[] = [];
    let maxTokens: number | undefined;

    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const started = performance.now();
      let provider: AIProvider | null = null;
      let response: AIResult<JobSummary>;
      try {
        provider = this.provider();
        response = provider
          ? await provider.generateStructured(
              buildJobSummaryRequest(built.json, {
                previousErrors,
                maxTokens,
                signal,
              }),
            )
          : {
              ok: false,
              error: {
                kind: 'AUTH',
                retryable: false,
                message: 'IA no configurada.',
              },
            };
      } catch {
        response = {
          ok: false,
          error: {
            kind: 'PROVIDER_DOWN',
            retryable: true,
            message: 'Proveedor no disponible.',
          },
        };
      }
      signal?.throwIfAborted();

      const rawText = response.ok
        ? (response.rawText ?? JSON.stringify(response.value))
        : response.error.rawText;
      const usage = response.ok ? response.usage : response.error.usage;
      const row = {
        id: randomUUID(),
        kind: 'JOB_SUMMARY' as const,
        resultId: null,
        jobId,
        provider: provider?.id ?? 'claude',
        model: response.ok
          ? response.model
          : (response.error.model ?? config.ai.analysisModel),
        promptVersion: PROMPT_VERSION,
        contextJson: built.json,
        responseJson: rawText ?? null,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        latencyMs: Math.round(
          response.ok
            ? response.latencyMs
            : (response.error.latencyMs ?? performance.now() - started),
        ),
        errorKind: response.ok ? null : response.error.kind,
      };

      // Sin respuesta utilizable del modelo: lo decide el worker (reintento, pausa o circuito).
      if (
        !response.ok &&
        !['INVALID_OUTPUT', 'INCOMPLETE', 'UNSAFE'].includes(
          response.error.kind,
        )
      ) {
        const status: AIStatus =
          response.error.kind === 'AUTH' ? 'NOT_CONFIGURED' : 'RETRY_WAIT';
        this.store.saveAttempt(
          { ...row, validationStatus: 'PROVIDER_ERROR' },
          status,
        );
        notify(status);
        return {
          status: 'PROVIDER_ERROR',
          error: {
            kind: response.error.kind,
            retryable: response.error.retryable,
            ...(response.error.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: response.error.retryAfterMs }),
          },
        };
      }

      const checked =
        !response.ok && response.error.kind === 'UNSAFE'
          ? {
              status: 'UNSAFE' as const,
              errors: ['Respuesta descartada por seguridad.'],
            }
          : validateJobSummary({
              rawText: rawText ?? '',
              truncated: !response.ok && response.error.kind === 'INCOMPLETE',
              context: built.context,
            });
      if (checked.status === 'VALID') {
        this.store.saveAttempt(
          { ...row, validationStatus: 'VALID' },
          'COMPLETED',
        );
        notify('COMPLETED');
        return { status: 'COMPLETED' };
      }
      const retry = attempt === 0 && checked.status !== 'UNSAFE';
      this.store.saveAttempt(
        { ...row, validationStatus: checked.status },
        retry ? 'RUNNING' : 'INVALID',
      );
      if (!retry) {
        notify('INVALID');
        return { status: 'INVALID' };
      }
      previousErrors = checked.errors;
      if (checked.status === 'INCOMPLETE')
        maxTokens = JOB_SUMMARY_RETRY_MAX_TOKENS;
    }
    throw new Error('Estado de validación inesperado.');
  }
}
