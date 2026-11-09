import type { z } from 'zod';

export interface StructuredRequest<T> {
  /** System instructions (optional). */
  system?: string;
  /** User message. */
  prompt: string;
  /** Output schema: sent as JSON Schema and the response is validated against it. */
  schema: z.ZodType<T>;
  maxTokens: number;
  /** External cancellation. The provider also adds its own timeout. */
  signal?: AbortSignal;
}

/** Copilot v2 content blocks, in Messages API format. */
export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

/** A message of the assistant conversation, in Messages API format. */
export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string | readonly AssistantBlock[];
}

/** Strict-mode tool, exactly as described by `ToolRegistry.definitions()`. */
export interface AssistantToolSpec {
  name: string;
  description: string;
  strict: true;
  input_schema: Record<string, unknown>;
}

/** Tool call requested by the model. Its arguments are validated again on execution. */
export interface AssistantToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Copilot turn. S4: free text. S5: with `tools` (strict mode) and `output`
 * (final response with `output_config.format`); the API accepts both in the same request.
 */
export interface AssistantTurnRequest<T = string> {
  system: string;
  /** They start and end with a user message (text or tool results). */
  messages: readonly AssistantMessage[];
  maxTokens: number;
  /** Model from `ai.assistantModel`; if missing, the provider default. */
  model?: string;
  signal?: AbortSignal;
  tools?: readonly AssistantToolSpec[];
  /**
   * 'none': tools are only declared (the API requires them if the history has
   * tool_use) and cannot be called. Used to request the structured final response.
   */
  toolChoice?: 'auto' | 'none';
  /** Final response schema. Without it, the final response is the text. */
  output?: z.ZodType<T>;
}

/** One loop step: the model requests tools or delivers the final response. */
export type AssistantStep<T = string> =
  | {
      kind: 'TOOL_CALLS';
      calls: AssistantToolCall[];
      /** Exact assistant content (text + tool_use) to send back on the next turn. */
      content: AssistantBlock[];
    }
  | { kind: 'FINAL'; value: T; text: string };

export type AIProviderId = 'claude' | 'openai' | 'local' | 'fake';

export interface AIProvider {
  readonly id: AIProviderId;
  healthCheck(): Promise<AIResult<{ model: string }>>;
  generateStructured<T>(req: StructuredRequest<T>): Promise<AIResult<T>>;
  /** One Copilot step: tool calls or final response (text or structured). */
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
      /** Exact text returned by the model: `AIResponseValidator` revalidates it and it is kept for audit. */
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
  /** Only if the model responded (e.g. INVALID_OUTPUT or INCOMPLETE): its exact text. */
  rawText?: string;
  /** Tokens consumed by that response, even if it is unusable. */
  usage?: AIUsage;
  /** Real metadata if there was a response, even when it failed validation. */
  model?: string;
  latencyMs?: number;
}
