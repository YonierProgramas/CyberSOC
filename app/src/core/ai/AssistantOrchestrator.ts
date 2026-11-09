import type { AppConfig } from '../config/AppConfig';
import type { Database } from '../persistence/Database';
import { ConversationRepository } from '../persistence/ConversationRepository';
import type { ReportBuilder } from '../reports/ReportBuilder';
import { Queue } from '../structures/Queue';
import {
  ASSISTANT_MESSAGE_MAX_CHARS,
  ASSISTANT_CARD_SCHEMA_V1,
  type AssistantAskQuery,
  type AssistantFocusDTO,
  type AssistantReplyDTO,
  type AssistantReportCardDTO,
  type AssistantToolCallDTO,
  type ConversationDTO,
  type ConversationQuery,
  type OpenConversationDTO,
} from '../../shared/ipc';
import type {
  AIErrorKind,
  AIProvider,
  AIResult,
  AssistantBlock,
  AssistantMessage,
  AssistantStep,
  AssistantTurnRequest,
} from './AIProvider';
import { toPromptSafeJson } from './AIContextBuilder';
import { anonymizeToolResult } from './anonymizeToolResult';
import { AssistantFocusBuilder, type FocusRef } from './AssistantFocus';
import {
  assistantReplyWireSchema,
  validateAssistantReply,
  type AssistantFinal,
  type AssistantReplyWire,
  type ReplyChecks,
} from './AssistantReply';
import { zoneOptionsFrom } from './ScanPlanValidator';
import type { ToolRegistry } from './tools/ToolRegistry';
import {
  ASSISTANT_MAX_TOKENS,
  ASSISTANT_SYSTEM_PROMPT,
  buildAssistantUserMessage,
  buildCorrectionMessage,
  FINAL_ANSWER_REQUEST,
} from './prompts/assistant.v2';

/** Size of the sliding window: the last 10 turns (S4 plan). */
export const ASSISTANT_HISTORY_TURNS = 10;
/** Orchestrator limits (S5 plan): per question. */
export const MAX_TOOL_ROUNDS = 6;
export const TOTAL_TIMEOUT_MS = 60_000;
/** A single correction when the final response cites nonexistent data. */
const MAX_CORRECTIONS = 1;
/** Cap on the response that is stored and displayed. */
const MAX_ANSWER_CHARS = 8_000;

/** One turn = one user question and the assistant response. */
export interface AssistantTurn {
  question: string;
  answer: string;
}

export interface AssistantOrchestratorOptions {
  db: Database;
  /** Read on every question: if the user changes the API key, the next turn already uses it. */
  provider: () => AIProvider | null;
  readConfig: () => Pick<AppConfig, 'ai'>;
  /** READ-ONLY tools (T5.3). None of them writes. */
  tools: Pick<ToolRegistry, 'definitions' | 'execute'>;
  /** `build_report` drafts (T5.4): validate `reportDraftId` and attach the wording. */
  reports: Pick<ReportBuilder, 'get' | 'attachNarrative'>;
  limits?: { maxToolRounds?: number; totalTimeoutMs?: number };
  /** Injectable clock for "today" in tests. */
  now?: () => Date;
}

type UnavailableKind = NonNullable<AssistantReplyDTO['errorKind']>;

const AI_STILL_WORKS =
  ' El escaneo, los veredictos y la cuarentena siguen funcionando sin IA.';

/** Fixed messages for the user. The provider error text is never displayed. */
const UNAVAILABLE_MESSAGES: Record<UnavailableKind, string> = {
  NOT_CONFIGURED:
    'La IA no está configurada. Agrega tu API key de Claude en Configuración para usar el SOC Copilot.' +
    AI_STILL_WORKS,
  OFFLINE: 'Sin conexión con la IA.' + AI_STILL_WORKS,
  TIMEOUT:
    'La IA no respondió a tiempo. Intenta de nuevo en unos segundos.' +
    AI_STILL_WORKS,
  RATE_LIMIT:
    'Se alcanzó el límite de peticiones de la IA. Espera un momento y vuelve a intentarlo.' +
    AI_STILL_WORKS,
  AUTH: 'La API de Claude rechazó la credencial. Revisa la API key en Configuración.',
  PROVIDER_DOWN: 'La IA no está disponible en este momento.' + AI_STILL_WORKS,
  INVALID_OUTPUT:
    'La respuesta de la IA no superó la validación de CyberSOC (citaba datos inexistentes o no cumplía el formato) y se descartó. Intenta de nuevo.',
  INCOMPLETE:
    'La respuesta se cortó por ser demasiado larga. Intenta una pregunta más concreta.',
  UNSAFE: 'El asistente no puede responder esa petición.',
  TOOL_LIMIT: `La pregunta necesitó más de ${MAX_TOOL_ROUNDS} consultas a los datos y se detuvo. Intenta una pregunta más concreta.`,
};

interface Outcome {
  status: AssistantReplyDTO['status'];
  text: string;
  errorKind: AssistantReplyDTO['errorKind'];
  final?: AssistantFinal;
  rejected?: string[];
  /** Model of the last response and tokens summed over all rounds of the question. */
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * SOC Copilot v2 (S5): answers with real data by querying read-only tools.
 * Reads SQLite (focus, tools and validations) and stores the conversation. It performs no
 * actions and starts no scans: plans and actions are only returned to the UI, where the
 * user confirms them. A response can never change a verdict.
 */
export class AssistantOrchestrator {
  // ---------------------------------------------------------------------------
  // SLIDING WINDOW of the history using the project Queue (FIFO).
  //
  // Invariant: the queue holds at most ASSISTANT_HISTORY_TURNS (10) turns, from oldest
  // (front, `peek`) to newest (back). When turn 11 arrives the front one is
  // removed: the oldest is always forgotten first, as in a line of people.
  //
  // Complejidad (n = turnos guardados, n ≤ 10):
  // - storing a turn: amortized O(1) enqueue + at most one O(1) dequeue;
  // - building the messages for the AI: O(n), the queue is traversed once (see `turns()`);
  // - reset: clear O(1).
  // Memory: O(n) turns, bounded to 10 even for very long conversations. This keeps the token
  // cost of each question from growing without limit. Tool queries of a
  // question do NOT enter the window: only the question/final-answer pair does.
  // ---------------------------------------------------------------------------
  private readonly history = new Queue<AssistantTurn>();

  // Questions are served one at a time (in arrival order): so two quick
  // questions neither read the same history nor store their turns out of order.
  private chain: Promise<unknown> = Promise.resolve();
  // Changes on every reset: a response arriving after "Nueva conversación" is discarded.
  private generation = 0;
  private controller: AbortController | undefined;
  private readonly focusBuilder: AssistantFocusBuilder;
  private readonly conversations: ConversationRepository;
  private conversationId: string | undefined;
  // Latest focused result with a response: anchors "estas dos detecciones" in the next question.
  private previousResultId: string | undefined;
  private readonly maxToolRounds: number;
  private readonly totalTimeoutMs: number;

  constructor(private readonly options: AssistantOrchestratorOptions) {
    this.conversations = new ConversationRepository(options.db);
    this.focusBuilder = new AssistantFocusBuilder(
      options.db,
      options.readConfig,
    );
    this.maxToolRounds = options.limits?.maxToolRounds ?? MAX_TOOL_ROUNDS;
    this.totalTimeoutMs = options.limits?.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  }

  /** Turns currently stored in the window (0 to 10). */
  get historyTurns(): number {
    return this.history.size;
  }

  /**
   * Copy of the turns, from oldest to newest, without modifying the window.
   * The Queue cannot be iterated, so it is "rotated": each turn leaves through the front and
   * re-enters through the back. After n rotations the queue is exactly the same. O(n).
   */
  turns(): AssistantTurn[] {
    const copy: AssistantTurn[] = [];
    const n = this.history.size;
    for (let i = 0; i < n; i += 1) {
      const turn = this.history.dequeue()!;
      copy.push(turn);
      this.history.enqueue(turn);
    }
    return copy;
  }

  /** Serves one question. AI failures do not throw: they come back as `UNAVAILABLE`. */
  ask(query: AssistantAskQuery): Promise<AssistantReplyDTO> {
    const generation = this.generation;
    const run = this.chain.then(() =>
      generation === this.generation
        ? this.answer(query)
        : this.reply(
            {
              status: 'CANCELLED',
              text: 'La conversación cambió.',
              errorKind: null,
            },
            { kind: 'NONE', id: null, label: null },
            [],
          ),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** "Nueva conversación": empties the window and cancels the question in progress. */
  reset(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
    this.history.clear();
    this.conversationId = undefined;
    this.previousResultId = undefined;
  }

  listConversations(query: ConversationQuery = {}): ConversationDTO[] {
    return this.conversations.list(query);
  }

  openConversation(id: string): OpenConversationDTO {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new Error('La conversación no existe.');
    const messages = this.conversations.recentMessages(
      id,
      ASSISTANT_HISTORY_TURNS,
    );
    const turns = this.conversations.recentCompletedTurns(id);
    // Read first: a nonexistent ID does not delete the active conversation.
    this.reset();
    this.conversationId = id;
    // Rehydrating the Queue in order keeps its FIFO invariant. O(t), t ≤ 10,
    // after the query: tools and attempts without a response are not complete pairs.
    for (const turn of turns) this.remember(turn);
    return { conversation, messages, historyTurns: this.historyTurns };
  }

  private async answer(query: AssistantAskQuery): Promise<AssistantReplyDTO> {
    const question = query.message.trim();
    if (question === '' || question.length > ASSISTANT_MESSAGE_MAX_CHARS)
      throw new RangeError(
        `La pregunta debe tener entre 1 y ${ASSISTANT_MESSAGE_MAX_CHARS} caracteres.`,
      );

    // Throws if the result or scan does not exist: a caller error, not an AI error.
    const ref: FocusRef = query.focus ?? {};
    const built = this.focusBuilder.build(ref);
    const focus: AssistantFocusDTO = {
      kind: built.focus.kind,
      id: ref.resultId ?? ref.jobId ?? null,
      label: built.label,
    };

    // History (without context or tools, to save tokens) + the new question
    // with the current focus and today's date.
    const messages: AssistantMessage[] = [];
    for (const turn of this.turns()) {
      messages.push({ role: 'user', content: turn.question });
      messages.push({ role: 'assistant', content: turn.answer });
    }
    messages.push({
      role: 'user',
      content: buildAssistantUserMessage(
        built.json,
        question,
        this.today(),
        this.previousResultId !== ref.resultId
          ? this.previousResultId
          : undefined,
      ),
    });

    const generation = this.generation;
    // Commit the question before calling the network: it survives a shutdown or failure.
    const conversationId = this.options.db.transaction(() => {
      const id =
        this.conversationId ??
        this.conversations.create(question.slice(0, 100)).id;
      this.conversations.append(id, [{ role: 'user', content: question }]);
      return id;
    });
    this.conversationId = conversationId;

    const controller = new AbortController();
    this.controller = controller;
    const toolCalls: AssistantToolCallDTO[] = [];
    let outcome: Outcome;
    try {
      outcome = await this.loop(
        messages,
        controller,
        toolCalls,
        conversationId,
        generation,
      );
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
    if (outcome.status !== 'ANSWERED' || !outcome.final)
      return this.reply(outcome, focus, toolCalls);

    const final = outcome.final;
    const reply = this.reply(outcome, focus, toolCalls);
    this.conversations.appendAnsweredWithCard(
      conversationId,
      {
        content: final.answer,
        model: outcome.model ?? null,
        inputTokens: outcome.usage?.inputTokens ?? null,
        outputTokens: outcome.usage?.outputTokens ?? null,
      },
      {
        schema: ASSISTANT_CARD_SCHEMA_V1,
        focus: reply.focus,
        references: reply.references,
        suggestedActions: reply.suggestedActions,
        report: reply.report,
        scanPlan: reply.scanPlan,
      },
    );
    this.remember({ question, answer: final.answer });
    if (ref.resultId) this.previousResultId = ref.resultId;
    return { ...reply, historyTurns: this.history.size };
  }

  /**
   * Tool loop: at most `maxToolRounds` rounds and `totalTimeoutMs` overall.
   * Each round runs the requested tools and returns their results as data.
   */
  private async loop(
    initial: AssistantMessage[],
    controller: AbortController,
    toolCalls: AssistantToolCallDTO[],
    conversationId: string,
    generation: number,
  ): Promise<Outcome> {
    const deadline = AbortSignal.timeout(this.totalTimeoutMs);
    const signal = AbortSignal.any([controller.signal, deadline]);
    const conversation = [...initial];
    const model = this.options.readConfig().ai.assistantModel;
    let rounds = 0;
    let corrections = 0;
    let rejected: string[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let usedModel: string | undefined;

    // One provider call: controlled errors and tokens summed across the whole question.
    const call = async <T>(
      request: Omit<
        AssistantTurnRequest<T>,
        'system' | 'maxTokens' | 'model' | 'signal'
      >,
    ): Promise<AIResult<AssistantStep<T>> | null> => {
      let response: AIResult<AssistantStep<T>> | null;
      try {
        const provider = this.options.provider();
        response = provider
          ? await provider.runAssistantTurn<T>({
              system: ASSISTANT_SYSTEM_PROMPT,
              maxTokens: ASSISTANT_MAX_TOKENS,
              model,
              signal,
              ...request,
            })
          : null;
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
      if (response?.ok) {
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        usedModel = response.model;
      }
      return response;
    };

    for (;;) {
      if (generation !== this.generation) return cancelled();
      if (deadline.aborted) return unavailable('TIMEOUT');

      // PHASE 1 (query): the 14 tools in strict mode, without output_config.
      // The API rejects combining them with the output schema ("compiled grammar is too large").
      const response = await call<string>({
        // Copy: the sent request does not change when the loop appends messages.
        messages: [...conversation],
        tools: this.options.tools.definitions(),
      });
      if (generation !== this.generation) return cancelled();
      if (response === null) return unavailable('NOT_CONFIGURED');
      if (!response.ok)
        return unavailable(
          deadline.aborted ? 'TIMEOUT' : response.error.kind,
          rejected,
        );
      const step = response.value;

      if (step.kind === 'TOOL_CALLS') {
        // Round maxToolRounds + 1: stops without running anything else.
        if (rounds >= this.maxToolRounds) return unavailable('TOOL_LIMIT');
        rounds += 1;
        conversation.push({ role: 'assistant', content: step.content });
        const results: AssistantBlock[] = [];
        const logged: unknown[] = [];
        for (const toolCall of step.calls) {
          // The registry validates the arguments with zod; unknown name → controlled error.
          const result = await this.options.tools.execute(
            toolCall.name,
            toolCall.input,
          );
          toolCalls.push({
            name: toolCall.name,
            ok: result.ok,
            code: result.ok ? null : result.error.code,
          });
          logged.push({
            name: toolCall.name,
            input: toolCall.input,
            ok: result.ok,
            ...(result.ok ? {} : { code: result.error.code }),
          });
          // Results are untrusted DATA (hostile file names, etc.):
          // they travel as escaped JSON, never as instructions, and with profile
          // paths anonymized (%USERPROFILE%): the person's name never leaves (AUD-04).
          results.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: toPromptSafeJson(anonymizeToolResult(result)),
            ...(result.ok ? {} : { is_error: true }),
          });
        }
        conversation.push({ role: 'user', content: results });
        this.conversations.append(conversationId, [
          {
            role: 'tool',
            content: step.calls.map((toolCall) => toolCall.name).join(', '),
            toolCallsJson: JSON.stringify(logged),
          },
        ]);
        continue;
      }

      // The model finished querying. If it already wrote the schema JSON, it is used as is
      // (zod validates it anyway); if it wrote prose, PHASE 2: the final response is requested with
      // output_config.format and tool_choice 'none' (tools are only declared).
      conversation.push({ role: 'assistant', content: step.text });
      let wire = parseWire(step.text);
      let wireText = step.text;
      if (!wire) {
        if (deadline.aborted) return unavailable('TIMEOUT');
        conversation.push({ role: 'user', content: FINAL_ANSWER_REQUEST });
        const structured = await call<AssistantReplyWire>({
          messages: [...conversation],
          tools: this.options.tools.definitions(),
          toolChoice: 'none',
          output: assistantReplyWireSchema,
        });
        if (generation !== this.generation) return cancelled();
        if (structured === null) return unavailable('NOT_CONFIGURED');
        if (!structured.ok)
          return unavailable(
            deadline.aborted ? 'TIMEOUT' : structured.error.kind,
            structured.error.kind === 'INVALID_OUTPUT'
              ? // Fixed provider message ("no cumple el esquema"), never AI text.
                [...rejected, `Respuesta final: ${structured.error.message}`]
              : rejected,
          );
        if (structured.value.kind !== 'FINAL')
          return unavailable('INVALID_OUTPUT', rejected);
        wire = structured.value.value;
        wireText = structured.value.text;
        conversation.push({ role: 'assistant', content: wireText });
      }

      const checked = await validateAssistantReply(wire, this.checks());
      if (checked.ok) {
        const final = {
          ...checked.final,
          answer: cleanAnswer(checked.final.answer),
        };
        if (final.answer === '') return unavailable('INVALID_OUTPUT');
        if (final.report)
          // AI wording attached to the draft: the exporter labels it "Generado por IA".
          this.options.reports.attachNarrative(final.report.reportDraftId, {
            executiveSummary: final.report.executiveSummary,
            conclusions: final.report.conclusions,
            citedResultIds: final.report.citedResultIds,
          });
        return {
          status: 'ANSWERED',
          text: final.answer,
          errorKind: null,
          final,
          model: usedModel,
          usage,
        };
      }
      rejected = checked.errors;
      if (corrections >= MAX_CORRECTIONS)
        return unavailable('INVALID_OUTPUT', rejected);
      corrections += 1;
      // The correction returns to phase 1: the model may query to find real IDs.
      conversation.push({
        role: 'user',
        content: buildCorrectionMessage(rejected),
      });
    }

    function cancelled(): Outcome {
      return {
        status: 'CANCELLED',
        text: 'La conversación se reinició.',
        errorKind: null,
      };
    }
  }

  /** Read-only checks to validate the final response. */
  private checks(): ReplyChecks {
    const db = this.options.db;
    const tools = this.options.tools;
    return {
      resultVerdict: (id) => {
        const row = db
          .prepare('SELECT verdict FROM scan_results WHERE id = ?')
          .get(id);
        return row ? String(row.verdict) : null;
      },
      jobExists: (id) =>
        db.prepare('SELECT 1 AS found FROM scan_jobs WHERE id = ?').get(id) !==
        undefined,
      ruleExists: async (id) =>
        (await tools.execute('get_rule_info', { ruleId: id })).ok,
      reportResultIds: (id) => {
        try {
          return this.options.reports
            .get(id)
            .results.map((row) => String(row.id));
        } catch {
          return null;
        }
      },
      zones: async () => {
        // The Core queries list_zones on its own: it does not trust what the AI says it saw.
        const result = await tools.execute('list_zones', {});
        return result.ok ? zoneOptionsFrom(result.data) : [];
      },
    };
  }

  private today(): string {
    const now = this.options.now?.() ?? new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /** Stores the turn in the sliding window. */
  private remember(turn: AssistantTurn): void {
    this.history.enqueue(turn); // enters at the back: amortized O(1)
    // If there are now 11, the oldest leaves through the front: O(1).
    if (this.history.size > ASSISTANT_HISTORY_TURNS) this.history.dequeue();
  }

  private reply(
    outcome: Outcome,
    focus: AssistantFocusDTO,
    toolCalls: AssistantToolCallDTO[],
  ): AssistantReplyDTO {
    const final = outcome.final;
    return {
      status: outcome.status,
      text: outcome.text,
      errorKind: outcome.errorKind,
      focus,
      historyTurns: this.history.size,
      references: final?.references ?? [],
      suggestedActions: final?.suggestedActions ?? [],
      report: final?.report ? this.reportCard(final.report) : null,
      scanPlan: final?.scanPlan ?? null,
      toolCalls,
      rejected: outcome.rejected ?? [],
    };
  }

  private reportCard(
    report: NonNullable<AssistantFinal['report']>,
  ): AssistantReportCardDTO {
    const draft = this.options.reports.get(report.reportDraftId);
    return {
      reportDraftId: report.reportDraftId,
      total: draft.total,
      verdicts: draft.verdicts.map((row) => ({
        verdict: String(row.verdict),
        count: Number(row.files),
      })),
      executiveSummary: report.executiveSummary,
      conclusions: report.conclusions,
      citedResultIds: report.citedResultIds,
      label: 'Generado por IA',
    };
  }
}

/** Phase 1 JSON, if the model already delivered it and it matches the schema; otherwise null. */
function parseWire(text: string): AssistantReplyWire | null {
  try {
    const parsed = assistantReplyWireSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function unavailable(
  kind: AIErrorKind | 'NOT_CONFIGURED' | 'TOOL_LIMIT',
  rejected: string[] = [],
): Outcome {
  return {
    status: 'UNAVAILABLE',
    text: UNAVAILABLE_MESSAGES[kind],
    errorKind: kind,
    rejected,
  };
}

/**
 * Removes control characters (except line breaks and tabs) and bounds the length.
 * The UI shows plain text: it also strips Markdown bold and headings that the model
 * writes despite the rules (the text stays the same, without asterisks or hash signs).
 */
function cleanAnswer(text: string): string {
  const clean = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .trim();
  return clean.length > MAX_ANSWER_CHARS
    ? `${clean.slice(0, MAX_ANSWER_CHARS)}…`
    : clean;
}
