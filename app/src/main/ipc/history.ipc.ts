import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import {
  DASHBOARD_GET_OVERVIEW,
  SCAN_LIST_JOBS_PAGE,
  ASSISTANT_LIST_CONVERSATIONS_PAGE,
  ASSISTANT_LIST_MESSAGES,
  type DashboardOverviewDTO,
  type DashboardOverviewQuery,
  type ScanJobsPageQuery,
  type Page,
  type ScanJobDTO,
  type ConversationPageQuery,
  type ConversationSummaryDTO,
  type ConversationMessagesQuery,
  type ConversationMessagesPageDTO,
} from '../../shared/ipc';
import {
  dashboardQuerySchema,
  dashboardOverviewSchema,
  scanJobsPageQuerySchema,
  jobsPageSchema,
  conversationPageQuerySchema,
  conversationsPageSchema,
  messagesQuerySchema,
  messagesPageSchema,
} from '../../shared/history-schemas';
import { requireTrustedSender } from './scan-validation';

export interface HistoryService {
  getOverview(query?: DashboardOverviewQuery): DashboardOverviewDTO;
  listJobsPage(query: ScanJobsPageQuery): Page<ScanJobDTO>;
  listConversationsPage(
    query: ConversationPageQuery,
  ): Page<ConversationSummaryDTO>;
  listMessages(query: ConversationMessagesQuery): ConversationMessagesPageDTO;
}

/** The four additive channels share the same close/validation, without touching the old ones. */
export function registerHistoryIpc(
  getWindow: () => BrowserWindow | null,
  trustedRendererUrl: string,
  service: HistoryService,
): () => void {
  let active = true;
  function register<T extends unknown[], R>(
    channel: string,
    argsSchema: z.ZodType<T>,
    outputSchema: z.ZodType<R>,
    read: (...args: T) => R,
    message: string,
  ) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      try {
        if (!active) throw new Error();
        requireTrustedSender(getWindow, trustedRendererUrl, event);
        const result = read(...argsSchema.parse(args));
        return outputSchema.parse(result);
      } catch (error) {
        if (
          channel === DASHBOARD_GET_OVERVIEW &&
          error instanceof RangeError &&
          error.message === 'INVALID_RANGE'
        )
          throw new Error('INVALID_RANGE');
        // Do not propagate SQLite/Zod errors, paths, content or private arguments.
        throw new Error(message);
      }
    });
  }
  register(
    DASHBOARD_GET_OVERVIEW,
    z.union([z.tuple([]), z.tuple([dashboardQuerySchema])]),
    dashboardOverviewSchema,
    (...args: [] | [DashboardOverviewQuery]) => service.getOverview(args[0]),
    'No se pudo consultar el resumen.',
  );
  register(
    SCAN_LIST_JOBS_PAGE,
    z.tuple([scanJobsPageQuerySchema]),
    jobsPageSchema,
    (query) => service.listJobsPage(query),
    'No se pudo consultar el historial de análisis.',
  );
  register(
    ASSISTANT_LIST_CONVERSATIONS_PAGE,
    z.tuple([conversationPageQuerySchema]),
    conversationsPageSchema,
    (query) => service.listConversationsPage(query),
    'No se pudieron consultar las conversaciones.',
  );
  register(
    ASSISTANT_LIST_MESSAGES,
    z.tuple([messagesQuerySchema]),
    messagesPageSchema,
    (query) => service.listMessages(query),
    'No se pudo consultar el archivo de mensajes.',
  );
  return () => {
    active = false;
    for (const channel of [
      DASHBOARD_GET_OVERVIEW,
      SCAN_LIST_JOBS_PAGE,
      ASSISTANT_LIST_CONVERSATIONS_PAGE,
      ASSISTANT_LIST_MESSAGES,
    ])
      ipcMain.removeHandler(channel);
  };
}
