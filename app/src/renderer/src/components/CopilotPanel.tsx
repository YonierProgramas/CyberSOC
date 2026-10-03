import { useState, useRef } from 'react';
import {
  ASSISTANT_MESSAGE_MAX_CHARS,
  type AssistantActionDTO,
  type AssistantReferenceDTO,
  type AssistantReplyDTO,
  type AssistantReportCardDTO,
  type ScanPlanCardDTO,
} from '../../../shared/ipc';
import { useCopilotFocus } from '../copilot/focus';
import { PlainText } from './PlainText';
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

export function CopilotPanel() {
  const { focus } = useCopilotFocus();
  const [draft, setDraft] = useState('');
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const talking =
    focus === null ? 'Ningún archivo o escaneo seleccionado' : focus.label;

  async function send(message: string) {
    const text = message.trim();
    if (!text || loading) return;
    const turn = generation.current;
    setDraft('');
    setLoading(true);
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

  async function reset() {
    generation.current += 1;
    setLoading(false);
    setDraft('');
    setLines([]);
    try {
      await window.cybersoc.assistant.reset();
    } catch {
      setLines([
        {
          id: nextLineId++,
          role: 'assistant',
          text: 'No se pudo reiniciar la conversación. Puedes seguir usando el resto de la aplicación.',
          unavailable: true,
          ...emptyCards,
        },
      ]);
    }
  }

  return (
    <aside className="copilot-panel" data-testid="copilot-panel">
      <h2>SOC Copilot</h2>
      <p data-testid="copilot-focus">Hablando de: {talking}</p>
      <div className="copilot-suggestions" data-testid="copilot-suggestions">
        {suggestions.map((question) => (
          <button
            key={question}
            type="button"
            data-testid="copilot-suggestion"
            disabled={loading}
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
            data-testid={
              line.role === 'assistant' ? 'copilot-reply' : undefined
            }
          >
            <p className="eyebrow">{line.role === 'user' ? 'Tú' : 'Copilot'}</p>
            {line.role === 'user' ? (
              <PlainText text={line.text} />
            ) : (
              <AssistantTurn line={line} />
            )}
          </div>
        ))}
        {loading && <p data-testid="copilot-loading">Consultando a la IA…</p>}
      </div>
      <form
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
            disabled={loading}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <div className="actions">
          <button
            type="submit"
            data-testid="copilot-send"
            disabled={loading || draft.trim() === ''}
          >
            Enviar
          </button>
          <button
            type="button"
            data-testid="copilot-reset"
            onClick={() => void reset()}
          >
            Nueva conversación
          </button>
        </div>
      </form>
    </aside>
  );
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
