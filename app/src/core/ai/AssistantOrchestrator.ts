import type { AppConfig } from '../config/AppConfig';
import type { Database } from '../persistence/Database';
import { Queue } from '../structures/Queue';
import {
  ASSISTANT_MESSAGE_MAX_CHARS,
  type AssistantAskQuery,
  type AssistantFocusDTO,
  type AssistantReplyDTO,
} from '../../shared/ipc';
import type {
  AIErrorKind,
  AIProvider,
  AIResult,
  AssistantMessage,
} from './AIProvider';
import { AssistantFocusBuilder, type FocusRef } from './AssistantFocus';
import {
  ASSISTANT_MAX_TOKENS,
  ASSISTANT_SYSTEM_PROMPT,
  buildAssistantUserMessage,
} from './prompts/assistant.v1';

/** Tamaño de la ventana deslizante: los últimos 10 turnos (plan S4). */
export const ASSISTANT_HISTORY_TURNS = 10;
/** Tope de la respuesta que se guarda y se muestra (unos 1 024 tokens caben de sobra). */
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
    'La IA devolvió una respuesta vacía o no válida. Intenta de nuevo.',
  INCOMPLETE:
    'La respuesta se cortó por ser demasiado larga. Intenta una pregunta más concreta.',
  UNSAFE: 'El asistente no puede responder esa petición.',
};

/**
 * SOC Copilot v1 (S4): responde preguntas sobre el resultado o escaneo seleccionado.
 * Solo lee SQLite (a través de AssistantFocusBuilder) y llama al proveedor: no escribe en la
 * base de datos ni ejecuta acciones, así que una respuesta nunca puede cambiar un veredicto.
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
  // en tokens de cada pregunta no crece sin límite.
  // ---------------------------------------------------------------------------
  private readonly history = new Queue<AssistantTurn>();

  // Las preguntas se atienden de una en una (en orden de llegada): así dos preguntas
  // rápidas no leen el mismo historial ni guardan sus turnos desordenados.
  private chain: Promise<unknown> = Promise.resolve();
  // Cambia en cada reset: una respuesta que llega después de "Nueva conversación" se descarta.
  private generation = 0;
  private controller: AbortController | undefined;
  private readonly focusBuilder: AssistantFocusBuilder;

  constructor(private readonly options: AssistantOrchestratorOptions) {
    this.focusBuilder = new AssistantFocusBuilder(
      options.db,
      options.readConfig,
    );
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
    const run = this.chain.then(() => this.answer(query));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** "Nueva conversación": vacía la ventana y cancela la pregunta en curso. */
  reset(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
    this.history.clear();
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

    // Historial (sin contexto, para ahorrar tokens) + la pregunta nueva con el foco actual.
    const messages: AssistantMessage[] = [];
    for (const turn of this.turns()) {
      messages.push({ role: 'user', content: turn.question });
      messages.push({ role: 'assistant', content: turn.answer });
    }
    messages.push({
      role: 'user',
      content: buildAssistantUserMessage(built.json, question),
    });

    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    let response: AIResult<string> | null;
    try {
      const provider = this.options.provider();
      response = provider
        ? await provider.runAssistantTurn({
            system: ASSISTANT_SYSTEM_PROMPT,
            messages,
            maxTokens: ASSISTANT_MAX_TOKENS,
            model: this.options.readConfig().ai.assistantModel,
            signal: controller.signal,
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
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }

    if (generation !== this.generation) {
      return this.reply(
        'CANCELLED',
        'La conversación se reinició.',
        null,
        focus,
      );
    }
    if (response === null) return this.unavailable('NOT_CONFIGURED', focus);
    if (!response.ok) return this.unavailable(response.error.kind, focus);

    const answer = cleanAnswer(response.value);
    if (answer === '') return this.unavailable('INVALID_OUTPUT', focus);
    this.remember({ question, answer });
    return this.reply('ANSWERED', answer, null, focus);
  }

  /** Guarda el turno en la ventana deslizante. */
  private remember(turn: AssistantTurn): void {
    this.history.enqueue(turn); // entra por el final: O(1) amortizado
    // Si ahora hay 11, el más antiguo sale por el frente: O(1).
    if (this.history.size > ASSISTANT_HISTORY_TURNS) this.history.dequeue();
  }

  private unavailable(
    kind: AIErrorKind | 'NOT_CONFIGURED',
    focus: AssistantFocusDTO,
  ): AssistantReplyDTO {
    return this.reply('UNAVAILABLE', UNAVAILABLE_MESSAGES[kind], kind, focus);
  }

  private reply(
    status: AssistantReplyDTO['status'],
    text: string,
    errorKind: AssistantReplyDTO['errorKind'],
    focus: AssistantFocusDTO,
  ): AssistantReplyDTO {
    return { status, text, errorKind, focus, historyTurns: this.history.size };
  }
}

/** Quita caracteres de control (salvo saltos de línea y tabuladores) y acota la longitud. */
function cleanAnswer(text: string): string {
  const clean = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  return clean.length > MAX_ANSWER_CHARS
    ? `${clean.slice(0, MAX_ANSWER_CHARS)}…`
    : clean;
}
