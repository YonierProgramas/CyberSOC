import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ASSISTANT_MESSAGE_MAX_CHARS,
  type AssistantActionDTO,
  type AssistantReferenceDTO,
  type AssistantReplyDTO,
  type AssistantReportCardDTO,
  type ConversationMessageDTO,
  type ScanPlanCardDTO,
} from '../../../shared/ipc';
import { useCopilotFocus } from '../copilot/focus';
import { AssistantIcon } from './icons';
import { AssistantArchive } from './AssistantArchive';
import { PlainText } from './PlainText';
import { StatusBadge } from './ui';
import { ReferenceChips } from './ReferenceChips';
import { ReportCard } from './ReportCard';
import { ScanPlanCard } from './ScanPlanCard';
import { SuggestedActions } from './SuggestedActions';

const suggestions = [
  '¿Por qué fue marcado?',
  '¿Qué capa lo detectó?',
  'Explícamelo de forma sencilla',
  '¿Qué debería hacer?',
] as const;

type ChatLine = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  unavailable: boolean;
  references: AssistantReferenceDTO[];
  suggestedActions: AssistantActionDTO[];
  report: AssistantReportCardDTO | null;
  scanPlan: ScanPlanCardDTO | null;
};

const emptyCards = {
  references: [] as AssistantReferenceDTO[],
  suggestedActions: [] as AssistantActionDTO[],
  report: null,
  scanPlan: null,
};

let nextLineId = 0;

export function CopilotPanel({
  open,
  narrow,
  onClose,
}: {
  open: boolean;
  narrow: boolean;
  onClose: () => void;
}) {
  const { focus } = useCopilotFocus();
  const [draft, setDraft] = useState('');
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('Consultando a la IA…');
  const [resetFailed, setResetFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const generation = useRef(0);
  const panelRef = useRef<HTMLElement>(null);

  const talking =
    focus === null ? 'Ningún archivo o escaneo seleccionado' : focus.label;

  useEffect(() => {
    if (!open) return;
    let active = true;
    void window.cybersoc.settings.ai
      .getStatus()
      .then((status) => {
        if (active) setConfigured(status.configured);
      })
      .catch(() => {
        if (active) setConfigured(null);
      });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !narrow) return;
    panelRef.current
      ?.querySelector<HTMLElement>('[data-testid="assistant-close"]')
      ?.focus();
  }, [open, narrow]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (
      event.defaultPrevented ||
      (event.target instanceof Element && event.target.closest('dialog[open]'))
    )
      return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (!narrow || event.key !== 'Tab' || !panelRef.current) return;
    const items = focusable(panelRef.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function send(message: string) {
    const text = message.trim();
    if (!text || loading || resetFailed) return;
    const turn = generation.current;
    setDraft('');
    setLoading(true);
    setLoadingText('Consultando a la IA…');
    setLines((current) => [
      ...current,
      {
        id: nextLineId++,
        role: 'user',
        text,
        unavailable: false,
        ...emptyCards,
      },
    ]);
    try {
      const reply = await window.cybersoc.assistant.ask({
        message: text,
        ...(focus?.kind === 'RESULT'
          ? { focus: { resultId: focus.resultId } }
          : focus?.kind === 'JOB'
            ? { focus: { jobId: focus.jobId } }
            : {}),
      });
      if (turn !== generation.current) return;
      appendReply(reply);
    } catch {
      if (turn !== generation.current) return;
      setLines((current) => [
        ...current,
        {
          id: nextLineId++,
          role: 'assistant',
          text: 'La IA no está disponible. El resto de la aplicación sigue funcionando.',
          unavailable: true,
          ...emptyCards,
        },
      ]);
    } finally {
      if (turn === generation.current) setLoading(false);
    }
  }

  function appendReply(reply: AssistantReplyDTO) {
    if (reply.status === 'CANCELLED') return;
    setLines((current) => [
      ...current,
      {
        id: nextLineId++,
        role: 'assistant',
        text: reply.text,
        unavailable: reply.status === 'UNAVAILABLE',
        references: reply.references ?? [],
        suggestedActions: reply.suggestedActions ?? [],
        report: reply.report ?? null,
        scanPlan: reply.scanPlan ?? null,
      },
    ]);
  }

  async function startNew() {
    const turn = ++generation.current;
    setLoading(true);
    setLoadingText('Preparando nueva conversación…');
    setResetFailed(false);
    setDraft('');
    setLines([]);
    setNotice('Nueva conversación. Las anteriores siguen en el archivo.');
    try {
      await window.cybersoc.assistant.reset();
    } catch {
      if (turn !== generation.current) return;
      setResetFailed(true);
      setNotice(
        'No se pudo preparar una conversación nueva. Reintenta o continúa una guardada.',
      );
      setLines([
        {
          id: nextLineId++,
          role: 'assistant',
          text: 'No se pudo reiniciar la conversación. Puedes seguir usando el resto de la aplicación.',
          unavailable: true,
          ...emptyCards,
        },
      ]);
    } finally {
      if (turn === generation.current) setLoading(false);
    }
  }

  async function continueConversation(conversationId: string) {
    const turn = ++generation.current;
    setLoading(true);
    setLoadingText('Cargando conversación…');
    setNotice(null);
    try {
      const opened =
        await window.cybersoc.assistant.openConversation(conversationId);
      if (turn !== generation.current) return;
      setResetFailed(false);
      setLines(opened.messages.map(messageToLine));
      setNotice(
        `Continuaste esta conversación. El modelo recibe ${opened.historyTurns} de los últimos 10 turnos. El archivo completo sigue guardado.`,
      );
    } catch {
      if (turn !== generation.current) return;
      setNotice(
        'No se pudo continuar esa conversación. El archivo sigue disponible.',
      );
    } finally {
      if (turn === generation.current) setLoading(false);
    }
  }

  return (
    <aside
      ref={panelRef}
      className="copilot-panel"
      data-testid="copilot-panel"
      hidden={!open}
      role={open && narrow ? 'dialog' : 'complementary'}
      aria-modal={open && narrow ? true : undefined}
      aria-labelledby="assistant-title"
      onKeyDown={onKeyDown}
    >
      <header className="copilot-head">
        <div>
          <p className="choice-icon">
            <AssistantIcon />
          </p>
          <h2 id="assistant-title">Asistente CyberSOC</h2>
          <p>
            {configured === null && (
              <StatusBadge tone="neutral">Sin confirmar</StatusBadge>
            )}
            {configured === true && (
              <StatusBadge tone="good">Clave configurada</StatusBadge>
            )}
            {configured === false && (
              <StatusBadge tone="warn">Sin configurar</StatusBadge>
            )}
          </p>
        </div>
        <button type="button" data-testid="assistant-close" onClick={onClose}>
          Cerrar
        </button>
      </header>
      <div className="copilot-scroll">
        {configured === false && (
          <p data-testid="assistant-unconfigured">
            La IA no está configurada. Puedes consultar el archivo igual.
          </p>
        )}
        <p data-testid="copilot-focus">Hablando de: {talking}</p>
        {focus === null && (
          <p className="hint">
            Sin un archivo o escaneo seleccionado, las preguntas no reciben
            datos de un resultado. Elige uno en Historial o en Escaneo.
          </p>
        )}
        {notice && <p data-testid="assistant-notice">{notice}</p>}
        <div className="copilot-suggestions" data-testid="copilot-suggestions">
          {suggestions.map((question) => (
            <button
              key={question}
              type="button"
              className="chip"
              data-testid="copilot-suggestion"
              disabled={loading || resetFailed}
              onClick={() => void send(question)}
            >
              {question}
            </button>
          ))}
        </div>
        <div className="copilot-log" aria-live="polite">
          {lines.map((line) => (
            <div
              key={line.id}
              className={
                line.role === 'user'
                  ? 'bubble bubble-user'
                  : 'bubble bubble-assistant'
              }
              data-testid={
                line.role === 'assistant' ? 'copilot-reply' : undefined
              }
            >
              <p className="eyebrow">
                {line.role === 'user' ? 'Tú' : 'Asistente'}
              </p>
              {line.role === 'user' ? (
                <PlainText text={line.text} />
              ) : (
                <AssistantTurn line={line} />
              )}
            </div>
          ))}
          {loading && (
            <p className="loading-line" data-testid="copilot-loading">
              {loadingText}
            </p>
          )}
        </div>
        <AssistantArchive onContinue={(id) => void continueConversation(id)} />
      </div>
      <form
        className="copilot-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <label>
          Mensaje
          <textarea
            data-testid="copilot-message"
            value={draft}
            maxLength={ASSISTANT_MESSAGE_MAX_CHARS}
            rows={3}
            disabled={loading || resetFailed}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <div className="actions">
          <button
            type="submit"
            data-testid="copilot-send"
            disabled={loading || resetFailed || draft.trim() === ''}
          >
            Enviar
          </button>
          <button
            type="button"
            data-testid="copilot-reset"
            onClick={() => void startNew()}
          >
            Nueva conversación
          </button>
        </div>
      </form>
    </aside>
  );
}

function messageToLine(message: ConversationMessageDTO): ChatLine {
  return {
    id: nextLineId++,
    role: message.role === 'user' ? 'user' : 'assistant',
    text:
      message.role === 'tool'
        ? 'Se consultó una herramienta. Los argumentos no se muestran.'
        : message.content,
    unavailable: false,
    ...emptyCards,
  };
}

function focusable(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button, textarea, input, select, a[href], summary',
    ),
  ].filter((item) => !item.hasAttribute('disabled') && item.tabIndex !== -1);
}

function AssistantTurn({ line }: { line: ChatLine }) {
  const [planOpen, setPlanOpen] = useState(false);
  return (
    <>
      {line.unavailable ? (
        <p className="plain-text" role="alert">
          {line.text}
        </p>
      ) : (
        <PlainText text={line.text} />
      )}
      <ReferenceChips references={line.references} />
      {line.report && <ReportCard report={line.report} />}
      {line.scanPlan && (
        <ScanPlanCard
          plan={line.scanPlan}
          open={planOpen}
          onOpen={() => setPlanOpen(true)}
          onClose={() => setPlanOpen(false)}
        />
      )}
      <SuggestedActions
        actions={line.suggestedActions}
        reportDraftId={line.report?.reportDraftId ?? null}
        hasPlan={line.scanPlan !== null}
        onRunPlan={() => setPlanOpen(true)}
      />
    </>
  );
}
