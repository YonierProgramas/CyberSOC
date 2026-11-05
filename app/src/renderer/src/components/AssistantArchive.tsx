import { useEffect, useRef, useState } from 'react';
import type {
  ArchivedActionAvailability,
  ArchivedActionStateDTO,
  ArchivedCardState,
  ConversationHistoryItemDTO,
  ConversationSummaryDTO,
} from '../../../shared/ipc';
import { archiveOffsetAfterReopen } from '../paging/arrival';
import { PlainText } from './PlainText';
import { ReferenceChips } from './ReferenceChips';
import { SuggestedActions } from './SuggestedActions';

// Diccionarios: una etiqueta por clave del contrato; consulta O(1) en este
// conjunto fijo. Recorrer las n acciones para mostrarlas cuesta O(n).
const availabilityLabel: Record<ArchivedActionAvailability, string> = {
  AVAILABLE: 'Disponible',
  MISSING: 'Ya no existe',
  NOT_APPLICABLE: 'No aplica',
  EXPIRED: 'Caducó',
  HISTORY_READ_ONLY: 'Solo lectura',
};

const CONVERSATION_PAGE_SIZE = 20;

const actionLabel: Record<ArchivedActionStateDTO['action'], string> = {
  OPEN_RESULT: 'Abrir resultado',
  QUARANTINE: 'Poner en cuarentena',
  ANALYZE_WITH_AI: 'Analizar con IA',
  OPEN_QUARANTINE: 'Abrir cuarentena',
  EXPORT_REPORT: 'Exportar reporte',
  RUN_SCAN_PLAN: 'Ejecutar plan',
};

export function AssistantArchive({
  onContinue,
}: {
  onContinue: (conversationId: string) => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummaryDTO[]>(
    [],
  );
  const [conversationTotal, setConversationTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const [selected, setSelected] = useState<ConversationSummaryDTO | null>(null);
  const [items, setItems] = useState<ConversationHistoryItemDTO[]>([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [messageLoading, setMessageLoading] = useState(false);
  const [messageFailed, setMessageFailed] = useState(false);
  const [messagesReady, setMessagesReady] = useState(false);
  // Cada contador invalida solo su lectura; paginar chats no cancela mensajes.
  const listRequest = useRef(0);
  const messageRequest = useRef(0);
  const requestedOffset = useRef(0);
  const totalRef = useRef(0);
  const hasBaseline = useRef(false);
  const requestedMessages = useRef<{
    conversation: ConversationSummaryDTO;
    before?: string;
  } | null>(null);

  useEffect(
    () => () => {
      listRequest.current += 1;
      messageRequest.current += 1;
    },
    [],
  );

  function applyConversationPage(
    nextOffset: number,
    page: { items: ConversationSummaryDTO[]; total: number },
  ) {
    requestedOffset.current = nextOffset;
    totalRef.current = page.total;
    hasBaseline.current = true;
    setOffset(nextOffset);
    setConversations(page.items);
    setConversationTotal(page.total);
    if (page.total === 0) {
      messageRequest.current += 1;
      requestedMessages.current = null;
      setSelected(null);
      setItems([]);
      setOlderCursor(null);
      setMessagesReady(false);
      setMessageLoading(false);
      setMessageFailed(false);
    }
  }

  async function loadConversations(nextOffset: number) {
    const token = ++listRequest.current;
    const previousTotal = totalRef.current;
    const baseline = hasBaseline.current;
    requestedOffset.current = nextOffset;
    setListLoading(true);
    setListFailed(false);
    setConversations([]);
    try {
      const page = await window.cybersoc.assistant.listConversationsPage({
        offset: nextOffset,
        limit: CONVERSATION_PAGE_SIZE,
      });
      if (token !== listRequest.current) return;
      const resolved = archiveOffsetAfterReopen({
        offset: nextOffset,
        previousTotal,
        nextTotal: page.total,
        hasBaseline: baseline,
      });
      if (resolved !== nextOffset) {
        const head = await window.cybersoc.assistant.listConversationsPage({
          offset: 0,
          limit: CONVERSATION_PAGE_SIZE,
        });
        if (token !== listRequest.current) return;
        applyConversationPage(0, head);
        return;
      }
      applyConversationPage(nextOffset, page);
    } catch {
      if (token === listRequest.current) setListFailed(true);
    } finally {
      if (token === listRequest.current) setListLoading(false);
    }
  }

  async function loadMessages(
    conversation: ConversationSummaryDTO,
    before?: string,
  ) {
    const token = ++messageRequest.current;
    const conversationId = conversation.id;
    requestedMessages.current = { conversation, before };
    setSelected(conversation);
    setMessageLoading(true);
    setMessageFailed(false);
    if (!before) {
      setItems([]);
      setOlderCursor(null);
      setMessageTotal(0);
      setMessagesReady(false);
    }
    try {
      const page = await window.cybersoc.assistant.listMessages({
        conversationId,
        limit: 30,
        ...(before ? { before } : {}),
      });
      if (token !== messageRequest.current) return;
      if (page.conversationId !== conversationId)
        throw new Error('Lectura no coincidente');
      setItems((current) =>
        before ? [...page.items, ...current] : page.items,
      );
      setOlderCursor(page.olderCursor);
      setMessageTotal(page.total);
      setMessagesReady(true);
    } catch {
      if (token === messageRequest.current) setMessageFailed(true);
    } finally {
      if (token === messageRequest.current) setMessageLoading(false);
    }
  }

  return (
    <details
      className="archive"
      data-testid="assistant-archive"
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.currentTarget.open) void loadConversations(offset);
      }}
    >
      <summary>Archivo de conversaciones</summary>
      <p>Leer una conversación no la continúa. El archivo no llama a la IA.</p>
      {listLoading && <p role="status">Cargando conversaciones…</p>}
      {listFailed && (
        <p role="alert">
          No se pudo cargar la página de conversaciones.{' '}
          <button
            type="button"
            data-testid="archive-list-retry"
            onClick={() => void loadConversations(requestedOffset.current)}
          >
            Reintentar
          </button>
        </p>
      )}
      <p data-testid="archive-total">
        {conversationTotal} conversaciones guardadas.
      </p>
      {!listLoading && !listFailed && (
        <p data-testid="archive-page-notice">
          {conversationTotal === 0
            ? 'No hay conversaciones guardadas.'
            : conversations.length === 0
              ? `Esta página no contiene conversaciones. Total: ${conversationTotal}.`
              : `Conversaciones ${offset + 1}–${offset + conversations.length} de ${conversationTotal}.`}
        </p>
      )}
      <div className="pager" aria-label="Páginas de conversaciones">
        <button
          type="button"
          data-testid="archive-prev"
          disabled={listLoading || offset === 0}
          onClick={() =>
            void loadConversations(Math.max(0, offset - CONVERSATION_PAGE_SIZE))
          }
        >
          Conversaciones anteriores
        </button>
        <button
          type="button"
          data-testid="archive-next"
          disabled={
            listLoading ||
            listFailed ||
            offset + conversations.length >= conversationTotal
          }
          onClick={() =>
            void loadConversations(offset + CONVERSATION_PAGE_SIZE)
          }
        >
          Conversaciones siguientes
        </button>
      </div>
      <ul className="job-list">
        {conversations.map((conversation) => (
          <li key={conversation.id}>
            <button
              type="button"
              data-testid="archive-conversation"
              aria-pressed={selected?.id === conversation.id}
              onClick={() => void loadMessages(conversation)}
            >
              {conversation.title?.trim() || 'Conversación sin título'} ·{' '}
              {conversation.messageCount} mensajes de usuario/asistente
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <div data-testid="archive-messages">
          <h3>Conversación: {selected.title?.trim() || 'Sin título'}</h3>
          {messageLoading && <p role="status">Cargando mensajes…</p>}
          {messageFailed && (
            <p role="alert">
              No se pudo leer esta conversación.{' '}
              <button
                type="button"
                data-testid="archive-messages-retry"
                onClick={() => {
                  const query = requestedMessages.current;
                  if (query)
                    void loadMessages(query.conversation, query.before);
                }}
              >
                Reintentar lectura
              </button>
            </p>
          )}
          {messagesReady && (
            <p data-testid="archive-message-count">
              {items.length} entradas visibles de {messageTotal} (mensajes y
              consultas de herramientas).
              {olderCursor || items.length < messageTotal
                ? ' Esta página no es toda la conversación.'
                : ''}
            </p>
          )}
          {olderCursor && (
            <button
              type="button"
              data-testid="archive-older"
              disabled={messageLoading || messageFailed}
              onClick={() => void loadMessages(selected, olderCursor)}
            >
              Mensajes anteriores
            </button>
          )}
          {items.map((item) => (
            <ArchiveItem key={item.id} item={item} />
          ))}
          <button
            type="button"
            data-testid="archive-continue"
            disabled={!messagesReady || messageLoading || messageFailed}
            onClick={() => onContinue(selected.id)}
          >
            Continuar esta conversación
          </button>
          <p>
            Al continuar, el modelo solo recibe los últimos 10 turnos. El
            archivo completo sigue guardado.
          </p>
        </div>
      )}
    </details>
  );
}

function ArchiveItem({ item }: { item: ConversationHistoryItemDTO }) {
  if (item.kind === 'USER') {
    return (
      <div>
        <p className="eyebrow">Tú</p>
        <PlainText text={item.text} />
        {!item.answered && <p>Esta pregunta no tiene respuesta.</p>}
      </div>
    );
  }
  if (item.kind === 'TOOLS') {
    return (
      <div data-testid="archive-tools">
        <p className="eyebrow">Consultas</p>
        {item.tools.map((tool, index) => (
          <PlainText
            key={`${item.id}:${index}`}
            text={`${tool.name}: ${tool.ok ? 'correcta' : 'no completada'}${
              tool.code ? `, código ${tool.code}` : ''
            }`}
          />
        ))}
      </div>
    );
  }
  const executable = item.actionStates
    .filter(
      (state) =>
        state.availability === 'AVAILABLE' && state.action !== 'RUN_SCAN_PLAN',
    )
    .map((state) => ({ action: state.action, targetId: state.targetId }));
  return (
    <div data-testid={`archive-card-${item.cardState}`}>
      <p className="eyebrow">Copilot</p>
      <PlainText text={item.text} />
      <p>{cardStateText(item.cardState)}</p>
      {item.card && (
        <>
          <ReferenceChips references={item.card.references} />
          {item.card.report && (
            <section data-testid="archive-report">
              <PlainText
                text={`${item.card.report.label}. ${item.card.report.total} resultados. ${item.card.report.executiveSummary}`}
              />
              <details>
                <summary>Ver detalles del reporte guardado</summary>
                <table>
                  <caption>Cifras guardadas del reporte</caption>
                  <thead>
                    <tr>
                      <th scope="col">Veredicto</th>
                      <th scope="col">Resultados</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.card.report.verdicts.map((row) => (
                      <tr key={row.verdict}>
                        <th scope="row">{row.verdict}</th>
                        <td>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h4>Conclusiones · {item.card.report.label}</h4>
                {item.card.report.conclusions.map((text, index) => (
                  <PlainText key={index} text={text} />
                ))}
                <ReferenceChips
                  references={item.card.report.citedResultIds.map((id) => ({
                    type: 'result' as const,
                    id,
                  }))}
                />
              </details>
            </section>
          )}
          {item.card.scanPlan && (
            <section data-testid="archive-plan">
              <PlainText
                text={`Plan antiguo, solo lectura. ${item.card.scanPlan.rationale}`}
              />
              <details>
                <summary>Ver destinos y perfil del plan guardado</summary>
                <ul>
                  {item.card.scanPlan.targets.map((target, index) => (
                    <li key={index}>
                      <p>
                        Zona: {target.zoneId}
                        {target.driveId ? ` · Unidad: ${target.driveId}` : ''}
                      </p>
                      {target.paths.map((path, index) => (
                        <PlainText key={index} text={path} />
                      ))}
                    </li>
                  ))}
                </ul>
                <p>Capas: {item.card.scanPlan.profile.layers.join(', ')}</p>
                <p>
                  Ocultos:{' '}
                  {item.card.scanPlan.profile.includeHidden ? 'sí' : 'no'} ·
                  Tamaño máximo: {item.card.scanPlan.profile.maxFileSizeMB} MB
                </p>
                {item.card.scanPlan.layerRationale.map((reason, index) => (
                  <div key={index}>
                    <p>{reason.layer} · Generado por IA</p>
                    <PlainText text={reason.why} />
                  </div>
                ))}
              </details>
            </section>
          )}
        </>
      )}
      <ul className="job-list">
        {item.actionStates.map((state) => (
          <li key={`${item.id}:${state.index}`}>
            {actionLabel[state.action]}: {availabilityLabel[state.availability]}
          </li>
        ))}
      </ul>
      <SuggestedActions
        actions={executable}
        reportDraftId={item.card?.report?.reportDraftId ?? null}
        hasPlan={false}
        onRunPlan={() => undefined}
      />
    </div>
  );
}

function cardStateText(state: ArchivedCardState): string {
  if (state === 'RECORDED') return 'Tarjeta guardada.';
  if (state === 'NOT_RECORDED') {
    return 'Esta respuesta no tiene tarjeta guardada.';
  }
  return 'La tarjeta no se pudo guardar.';
}
