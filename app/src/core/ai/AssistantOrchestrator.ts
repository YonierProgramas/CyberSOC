import type { AppConfig } from '../config/AppConfig';
import type { Database } from '../persistence/Database';
import { ConversationRepository } from '../persistence/ConversationRepository';
import type { ReportBuilder } from '../reports/ReportBuilder';
import { Queue } from '../structures/Queue';
import {
  ASSISTANT_MESSAGE_MAX_CHARS,
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

/** Tamaño de la ventana deslizante: los últimos 10 turnos (plan S4). */
export const ASSISTANT_HISTORY_TURNS = 10;
/** Límites del orquestador (plan S5): por pregunta. */
export const MAX_TOOL_ROUNDS = 6;
export const TOTAL_TIMEOUT_MS = 60_000;
/** Una sola corrección cuando la respuesta final cita datos inexistentes. */
const MAX_CORRECTIONS = 1;
/** Tope de la respuesta que se guarda y se muestra. */
const MAX_ANSWER_CHARS = 8_000;

/** Un turno = una pregunta del usuario y la respuesta del asistente. */
export interface AssistantTurn {
  question: string;
  answer: string;
}

export interface AssistantOrchestratorOptions {
  db: Database;
  /** Se lee en cada pregunta: si el usuario cambia la API key, el siguiente turno ya la usa. */
  provider: () => AIProvider | null;
  readConfig: () => Pick<AppConfig, 'ai'>;
  /** Herramientas de SOLO lectura (T5.3). No existe ninguna que escriba. */
  tools: Pick<ToolRegistry, 'definitions' | 'execute'>;
  /** Borradores de `build_report` (T5.4): validar `reportDraftId` y adjuntar la redacción. */
  reports: Pick<ReportBuilder, 'get' | 'attachNarrative'>;
  limits?: { maxToolRounds?: number; totalTimeoutMs?: number };
  /** Reloj inyectable para "hoy" en las pruebas. */
  now?: () => Date;
}

type UnavailableKind = NonNullable<AssistantReplyDTO['errorKind']>;

const AI_STILL_WORKS =
  ' El escaneo, los veredictos y la cuarentena siguen funcionando sin IA.';

/** Mensajes fijos para el usuario. Nunca se muestra el texto de error del proveedor. */
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
  /** Modelo de la última respuesta y tokens sumados de todas las rondas de la pregunta. */
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * SOC Copilot v2 (S5): responde con datos reales consultando herramientas de solo lectura.
 * Lee SQLite (foco, herramientas y validaciones) y guarda la conversación. No ejecuta
 * acciones ni inicia escaneos: los planes y acciones solo se devuelven a la UI, donde el
 * usuario los confirma. Una respuesta nunca puede cambiar un veredicto.
 */
export class AssistantOrchestrator {
  // ---------------------------------------------------------------------------
  // VENTANA DESLIZANTE del historial con la Queue del proyecto (FIFO).
  //
  // Invariante: la cola guarda como máximo ASSISTANT_HISTORY_TURNS (10) turnos, del más
  // antiguo (frente, `peek`) al más reciente (final). Al entrar el turno 11 se saca el
  // del frente: siempre se olvida primero lo más viejo, como en una fila.
  //
  // Complejidad (n = turnos guardados, n ≤ 10):
  // - guardar un turno: enqueue O(1) amortizado + a lo sumo un dequeue O(1);
  // - armar los mensajes para la IA: O(n), se recorre la cola una vez (ver `turns()`);
  // - reset: clear O(1).
  // Memoria: O(n) turnos, acotada a 10 aunque la conversación sea muy larga. Así el costo
  // en tokens de cada pregunta no crece sin límite. Las consultas a herramientas de una
  // pregunta NO entran en la ventana: solo el par pregunta/respuesta final.
  // ---------------------------------------------------------------------------
  private readonly history = new Queue<AssistantTurn>();

  // Las preguntas se atienden de una en una (en orden de llegada): así dos preguntas
  // rápidas no leen el mismo historial ni guardan sus turnos desordenados.
  private chain: Promise<unknown> = Promise.resolve();
  // Cambia en cada reset: una respuesta que llega después de "Nueva conversación" se descarta.
  private generation = 0;
  private controller: AbortController | undefined;
  private readonly focusBuilder: AssistantFocusBuilder;
  private readonly conversations: ConversationRepository;
  private conversationId: string | undefined;
  // Último resultado en foco con respuesta: ancla "estas dos detecciones" en la pregunta siguiente.
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

  /** Turnos guardados ahora mismo en la ventana (0 a 10). */
  get historyTurns(): number {
    return this.history.size;
  }

  /**
   * Copia de los turnos, del más antiguo al más reciente, sin modificar la ventana.
   * La Queue no se puede recorrer, así que se "rota": cada turno sale por el frente y
   * vuelve a entrar por el final. Tras n vueltas la cola queda exactamente igual. O(n).
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

  /** Atiende una pregunta. Los fallos de la IA no lanzan: vuelven como `UNAVAILABLE`. */
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

  /** "Nueva conversación": vacía la ventana y cancela la pregunta en curso. */
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
    // Leer primero: un ID inexistente no borra la conversación activa.
    this.reset();
    this.conversationId = id;
    // Rehidratar la Queue en orden mantiene su invariante FIFO. O(t), t ≤ 10,
    // después de la consulta: herramientas e intentos sin respuesta no son pares completos.
    for (const turn of turns) this.remember(turn);
    return { conversation, messages, historyTurns: this.historyTurns };
  }

  private async answer(query: AssistantAskQuery): Promise<AssistantReplyDTO> {
    const question = query.message.trim();
    if (question === '' || question.length > ASSISTANT_MESSAGE_MAX_CHARS)
      throw new RangeError(
        `La pregunta debe tener entre 1 y ${ASSISTANT_MESSAGE_MAX_CHARS} caracteres.`,
      );

    // Lanza si el resultado o el escaneo no existen: es un error del llamador, no de la IA.
    const ref: FocusRef = query.focus ?? {};
    const built = this.focusBuilder.build(ref);
    const focus: AssistantFocusDTO = {
      kind: built.focus.kind,
      id: ref.resultId ?? ref.jobId ?? null,
      label: built.label,
    };

    // Historial (sin contexto ni herramientas, para ahorrar tokens) + la pregunta nueva
    // con el foco actual y la fecha de hoy.
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
    // Confirmar la pregunta antes de llamar a la red: sobrevive a un cierre o fallo.
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
    this.conversations.append(conversationId, [
      {
        role: 'assistant',
        content: final.answer,
        model: outcome.model ?? null,
        inputTokens: outcome.usage?.inputTokens ?? null,
        outputTokens: outcome.usage?.outputTokens ?? null,
      },
    ]);
    this.remember({ question, answer: final.answer });
    if (ref.resultId) this.previousResultId = ref.resultId;
    return this.reply(outcome, focus, toolCalls);
  }

  /**
   * Bucle de herramientas: como mucho `maxToolRounds` rondas y `totalTimeoutMs` en total.
   * Cada ronda ejecuta las herramientas pedidas y devuelve sus resultados como datos.
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

    // Una llamada al proveedor: errores controlados y tokens sumados de toda la pregunta.
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

      // FASE 1 (consulta): las 14 herramientas en modo estricto, sin output_config.
      // La API rechaza combinarlas con el esquema de salida ("compiled grammar is too large").
      const response = await call<string>({
        // Copia: la petición enviada no cambia cuando el bucle agrega mensajes.
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
        // Ronda maxToolRounds + 1: se corta sin ejecutar nada más.
        if (rounds >= this.maxToolRounds) return unavailable('TOOL_LIMIT');
        rounds += 1;
        conversation.push({ role: 'assistant', content: step.content });
        const results: AssistantBlock[] = [];
        const logged: unknown[] = [];
        for (const toolCall of step.calls) {
          // El registro valida los argumentos con zod; nombre desconocido → error controlado.
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
          // Los resultados son DATOS no confiables (nombres de archivo hostiles, etc.):
          // viajan como JSON escapado, nunca como instrucciones.
          results.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: toPromptSafeJson(result),
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

      // El modelo terminó de consultar. Si ya escribió el JSON del esquema, se usa tal cual
      // (zod lo valida igual); si escribió prosa, FASE 2: se pide la respuesta final con
      // output_config.format y tool_choice 'none' (las herramientas solo se declaran).
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
              ? // Mensaje fijo del proveedor ("no cumple el esquema"), nunca texto de la IA.
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
          // Redacción de IA adjunta al borrador: el exportador la marca "Generado por IA".
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
      // La corrección vuelve a la fase 1: el modelo puede consultar para hallar IDs reales.
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

  /** Comprobaciones de solo lectura para validar la respuesta final. */
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
        // El Core consulta list_zones por su cuenta: no confía en lo que la IA diga que vio.
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

  /** Guarda el turno en la ventana deslizante. */
  private remember(turn: AssistantTurn): void {
    this.history.enqueue(turn); // entra por el final: O(1) amortizado
    // Si ahora hay 11, el más antiguo sale por el frente: O(1).
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

/** JSON de la fase 1, si el modelo ya lo entregó y cumple el esquema; si no, null. */
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
 * Quita caracteres de control (salvo saltos de línea y tabuladores) y acota la longitud.
 * La UI muestra texto plano: también quita negritas y títulos de Markdown que el modelo
 * escriba a pesar de las reglas (el texto queda igual, sin asteriscos ni almohadillas).
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
