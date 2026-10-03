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

/** Bloques de contenido del Copilot v2, en el formato de la Messages API. */
export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

/** Un mensaje de la conversación del asistente, en el formato de la Messages API. */
export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string | readonly AssistantBlock[];
}

/** Herramienta en modo estricto, tal como la describe `ToolRegistry.definitions()`. */
export interface AssistantToolSpec {
  name: string;
  description: string;
  strict: true;
  input_schema: Record<string, unknown>;
}

/** Llamada a herramienta pedida por el modelo. Sus argumentos se validan otra vez al ejecutar. */
export interface AssistantToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Turno del Copilot. S4: texto libre. S5: con `tools` (modo estricto) y `output`
 * (respuesta final con `output_config.format`); la API admite ambos en la misma petición.
 */
export interface AssistantTurnRequest<T = string> {
  system: string;
  /** Empiezan y terminan con un mensaje del usuario (texto o resultados de herramientas). */
  messages: readonly AssistantMessage[];
  maxTokens: number;
  /** Modelo de `ai.assistantModel`; si falta, el del proveedor. */
  model?: string;
  signal?: AbortSignal;
  tools?: readonly AssistantToolSpec[];
  /**
   * 'none': las herramientas solo se declaran (la API las exige si el historial tiene
   * tool_use) y no pueden llamarse. Se usa para pedir la respuesta final estructurada.
   */
  toolChoice?: 'auto' | 'none';
  /** Esquema de la respuesta final. Sin él, la respuesta final es el texto. */
  output?: z.ZodType<T>;
}

/** Un paso del bucle: el modelo pide herramientas o entrega la respuesta final. */
export type AssistantStep<T = string> =
  | {
      kind: 'TOOL_CALLS';
      calls: AssistantToolCall[];
      /** Contenido exacto del asistente (texto + tool_use) para devolverlo en el siguiente turno. */
      content: AssistantBlock[];
    }
  | { kind: 'FINAL'; value: T; text: string };

export type AIProviderId = 'claude' | 'openai' | 'local' | 'fake';

export interface AIProvider {
  readonly id: AIProviderId;
  healthCheck(): Promise<AIResult<{ model: string }>>;
  generateStructured<T>(req: StructuredRequest<T>): Promise<AIResult<T>>;
  /** Un paso del Copilot: llamadas a herramientas o respuesta final (texto o estructurada). */
  runAssistantTurn<T = string>(
    req: AssistantTurnRequest<T>,
  ): Promise<AIResult<AssistantStep<T>>>;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AIResult<T> =
  | {
      ok: true;
      value: T;
      model: string;
      usage: AIUsage;
      latencyMs: number;
      /** Texto exacto devuelto por el modelo: lo revalida `AIResponseValidator` y se guarda para auditoría. */
      rawText?: string;
    }
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
  /** Solo si hubo respuesta del modelo (p. ej. INVALID_OUTPUT o INCOMPLETE): su texto exacto. */
  rawText?: string;
  /** Tokens consumidos por esa respuesta, aunque no sea utilizable. */
  usage?: AIUsage;
  /** Metadatos reales si hubo respuesta, incluso cuando no pasó la validación. */
  model?: string;
  latencyMs?: number;
}
