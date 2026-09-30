import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/AppConfig';
import type { AIStatus } from '../persistence/assessmentTypes';
import type { AIProvider, AIError, AIResult } from './AIProvider';
import { AIContextBuilder } from './AIContextBuilder';
import { AIAnalysisStore } from './AIAnalysisStore';
import { validateAIResponse } from './AIResponseValidator';
import {
  buildAnalysisRequest,
  PROMPT_VERSION,
  ANALYSIS_RETRY_MAX_TOKENS,
} from './prompts/analysis.v1';
import type { AIAssessment } from './schemas';

export type AnalysisOutcome =
  | { status: 'COMPLETED' | 'INVALID' }
  | {
      status: 'PROVIDER_ERROR';
      error: Pick<AIError, 'kind' | 'retryable' | 'retryAfterMs'>;
    };

export class AISecurityService {
  constructor(
    readonly store: AIAnalysisStore,
    private readonly provider: () => AIProvider | null,
    private readonly readConfig: () => AppConfig,
  ) {}

  async analyze(
    resultId: string,
    signal?: AbortSignal,
    notify: (status: AIStatus) => void = () => {},
  ): Promise<AnalysisOutcome> {
    const { result, analysis } = this.store.load(resultId);
    const config = this.readConfig();
    const built = new AIContextBuilder(() => config).build(result, analysis);
    this.store.setStatus(resultId, 'RUNNING');
    notify('RUNNING');
    let previousErrors: string[] = [];
    let maxTokens: number | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const started = performance.now();
      let provider: AIProvider | null = null;
      let response: AIResult<AIAssessment>;
      try {
        provider = this.provider();
        response = provider
          ? await provider.generateStructured(
              buildAnalysisRequest(built.json, {
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
        kind: 'FILE_RESULT' as const,
        resultId,
        jobId: result.jobId,
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
      if (
        !response.ok &&
        !['INVALID_OUTPUT', 'INCOMPLETE', 'UNSAFE'].includes(
          response.error.kind,
        )
      ) {
        const status =
          response.error.kind === 'AUTH' ? 'NOT_CONFIGURED' : 'RETRY_WAIT';
        this.store.saveAttempt(
          { ...row, validationStatus: 'PROVIDER_ERROR' },
          status,
          { validationStatus: 'PROVIDER_ERROR' },
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
          : validateAIResponse({
              rawText: rawText ?? '',
              truncated: !response.ok && response.error.kind === 'INCOMPLETE',
              context: built.context,
            });
      if (checked.status === 'VALID') {
        this.store.saveAttempt(
          { ...row, validationStatus: 'VALID' },
          'COMPLETED',
          {
            validationStatus: 'VALID',
            opinion: checked.assessment.opinion,
            confidence: checked.assessment.confidence,
          },
        );
        notify('COMPLETED');
        return { status: 'COMPLETED' };
      }
      const retry = attempt === 0 && checked.status !== 'UNSAFE';
      this.store.saveAttempt(
        { ...row, validationStatus: checked.status },
        retry ? 'RUNNING' : 'INVALID',
        { validationStatus: checked.status },
      );
      if (!retry) {
        notify('INVALID');
        return { status: 'INVALID' };
      }
      previousErrors = checked.errors;
      if (checked.status === 'INCOMPLETE')
        maxTokens = ANALYSIS_RETRY_MAX_TOKENS;
    }
    throw new Error('Estado de validación inesperado.');
  }
}
