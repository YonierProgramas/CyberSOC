import type { z } from 'zod';

export interface StructuredRequest<T> {
  /** Instrucciones del sistema (opcional). */
  system?: string;
  /** Mensaje del usuario. */
  prompt: string;
  /** Esquema de la salida: se envía como JSON Schema y la respuesta se valida con él. */
  schema: z.ZodType<T>;
  maxTokens: number;
  /** Cancelación externa. El proveedor añade además su propio timeout. */
  signal?: AbortSignal;
}

export type AIProviderId = 'claude' | 'openai' | 'local' | 'fake';

export interface AIProvider {
  readonly id: AIProviderId;
  healthCheck(): Promise<AIResult<{ model: string }>>;
  generateStructured<T>(req: StructuredRequest<T>): Promise<AIResult<T>>;
  // runAssistantTurn(...) se añade en S4/S5
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AIResult<T> =
  | { ok: true; value: T; model: string; usage: AIUsage; latencyMs: number }
  | { ok: false; error: AIError };

export type AIErrorKind =
  | 'OFFLINE'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'AUTH'
  | 'PROVIDER_DOWN'
  | 'INVALID_OUTPUT'
  | 'INCOMPLETE'
  | 'UNSAFE';

export interface AIError {
  kind: AIErrorKind;
  retryable: boolean;
  retryAfterMs?: number;
  message: string;
}
