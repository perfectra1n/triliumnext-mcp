import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import {
  clearBusy,
  dedupe,
  getBusy,
  markBusy,
  retryAfterSeconds,
  type BusyState,
} from './hostGuard.js';
import type {
  Note,
  NoteWithBranch,
  CreateNoteDef,
  PatchNoteDef,
  Branch,
  CreateBranchDef,
  PatchBranchDef,
  Attribute,
  CreateAttributeDef,
  PatchAttributeDef,
  Attachment,
  CreateAttachmentDef,
  PatchAttachmentDef,
  SearchResponse,
  SearchParams,
  AppInfo,
  EtapiError,
  EntityId,
  Revision,
  RecentChange,
  UndeleteResponse,
} from '../types/etapi.js';

/** Surface the root cause (e.g. ECONNREFUSED) that undici hides in `cause`. */
function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? error.message;
}

export class TriliumClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'TriliumClientError';
  }
}

/** Transport-level tuning for {@link TriliumClient}. All fields are optional. */
export interface TriliumClientOptions {
  /** Per-request timeout in ms (default 60s). Export/import get 5x this. */
  timeoutMs?: number;
  /** Retries for idempotent requests on network errors or 502/503/504 (default 2). */
  maxRetries?: number;
  /** Base backoff between retries in ms, doubled each attempt (default 250). */
  retryDelayMs?: number;
  /**
   * How long a Trilium host stays marked busy after a request to it times out
   * (default 30s). Shared by every client for that host; see hostGuard.ts.
   */
  busyCooldownMs?: number;
  /** Timeout for cheap requests while the host is marked busy (default 5s). */
  busyProbeTimeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_BUSY_COOLDOWN_MS = 30_000;
export const DEFAULT_BUSY_PROBE_TIMEOUT_MS = 5_000;

/** Map server config onto client options; unset fields keep the client defaults. */
export function clientOptionsFromConfig(config: {
  requestTimeoutMs?: number;
  busyCooldownMs?: number;
}): TriliumClientOptions {
  return { timeoutMs: config.requestTimeoutMs, busyCooldownMs: config.busyCooldownMs };
}

/**
 * Methods safe to replay: repeating them leaves the server in the same state.
 * POST is excluded — create-note, branches and attachments would duplicate.
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']);

/** Gateway-ish statuses that usually mean "try again in a moment". */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TriliumClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly webBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly busyCooldownMs: number;
  private readonly busyProbeTimeoutMs: number;
  /** In-flight requests are only shared between callers holding the same token. */
  private readonly dedupeScope: string;

  /**
   * @param baseUrl  ETAPI base URL (e.g. `http://host:port/etapi`).
   * @param token    ETAPI auth token.
   * @param webBaseUrl  Optional user-facing web-UI root for clickable note links.
   *   When omitted, it is derived from `baseUrl` by stripping a trailing `/etapi`.
   */
  constructor(
    baseUrl: string,
    token: string,
    webBaseUrl?: string,
    options: TriliumClientOptions = {}
  ) {
    // Remove trailing slash if present
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.webBaseUrl = (webBaseUrl ?? baseUrl).replace(/\/etapi\/*$/i, '').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.busyCooldownMs = options.busyCooldownMs ?? DEFAULT_BUSY_COOLDOWN_MS;
    this.busyProbeTimeoutMs = options.busyProbeTimeoutMs ?? DEFAULT_BUSY_PROBE_TIMEOUT_MS;
    const tokenTag = createHash('sha256').update(token).digest('hex').slice(0, 16);
    this.dedupeScope = `${this.baseUrl}|${tokenTag}`;
  }

  /**
   * Seconds until this client's Trilium host stops being treated as busy, or
   * null when it is not marked busy.
   */
  busyRetryAfterSeconds(): number | null {
    const state = getBusy(this.baseUrl);
    return state ? retryAfterSeconds(state) : null;
  }

  private busyError(state: BusyState): TriliumClientError {
    const since = Math.round((Date.now() - state.since) / 1000);
    return new TriliumClientError(
      503,
      'TRILIUM_BUSY',
      `Trilium at ${this.baseUrl} is busy: ${state.reason} timed out ${since}s ago and Trilium ` +
        `has not answered since. Try again in about ${retryAfterSeconds(state)}s.`
    );
  }

  /**
   * A timeout means Trilium is wedged, usually by one slow full-text search
   * holding its single SQL thread. Flag the host so the next callers fail fast.
   */
  private onTimeout(
    busyBefore: BusyState | undefined,
    what: string,
    message: string
  ): TriliumClientError {
    const state = markBusy(this.baseUrl, this.busyCooldownMs, what);
    return busyBefore
      ? this.busyError(state)
      : new TriliumClientError(504, 'TRILIUM_TIMEOUT', message);
  }

  /** The user-facing Trilium web-UI base URL used for note links. */
  getWebBaseUrl(): string {
    return this.webBaseUrl;
  }

  /**
   * Builds a clickable web-UI URL that opens the given note in Trilium, of the
   * form `<webBase>/#root/<ancestors>/<noteId>`. Walks `parentNoteIds` up to the
   * root to construct the full note path.
   *
   * Never throws: if the ancestor walk fails (e.g. a parent lookup errors), it
   * falls back to a bare `<webBase>/#<noteId>` link, which Trilium still resolves.
   * URL building must never break the create/edit operation that produced it.
   *
   * @param viaParentNoteId Optional known immediate parent, used for the first
   *   hop to save a `getNote` call (e.g. the branch parent of a just-created note).
   */
  async getNoteUrl(noteId: EntityId, viaParentNoteId?: EntityId): Promise<string> {
    try {
      const path = await this.buildNotePath(noteId, viaParentNoteId);
      return `${this.webBaseUrl}/#${path}`;
    } catch {
      return `${this.webBaseUrl}/#${noteId}`;
    }
  }

  /**
   * The note's tree path, `root/<ancestors>/<noteId>`, as used by Trilium
   * reference links. Unlike {@link getNoteUrl} this throws when the walk fails.
   */
  async getNotePath(noteId: EntityId, viaParentNoteId?: EntityId): Promise<string> {
    return this.buildNotePath(noteId, viaParentNoteId);
  }

  private async buildNotePath(noteId: EntityId, viaParentNoteId?: EntityId): Promise<string> {
    if (noteId === 'root') return 'root';

    const segments: EntityId[] = [noteId];
    const seen = new Set<EntityId>([noteId]);
    let cursor = noteId;
    let hint = viaParentNoteId;

    // Cap the walk to guard against unexpected cycles or pathological depth.
    for (let depth = 0; depth < 50; depth++) {
      let parentId = hint;
      hint = undefined; // hint only applies to the first hop
      if (parentId === undefined) {
        const note = await this.getNote(cursor);
        parentId = note.parentNoteIds.find((p) => !seen.has(p));
      }

      if (!parentId || parentId === 'root') {
        segments.unshift('root');
        return segments.join('/');
      }

      segments.unshift(parentId);
      seen.add(parentId);
      cursor = parentId;
    }

    // Depth cap hit without reaching root — prefix what we have so the link is
    // still anchored under root.
    segments.unshift('root');
    return segments.join('/');
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      contentType?: string;
      responseType?: 'json' | 'text' | 'arraybuffer';
      /** Multiplier on the client timeout for slow endpoints (export/import). */
      timeoutFactor?: number;
      /**
       * Slow on Trilium's side (a full-text search). Refused outright while the
       * host is marked busy, because it would queue behind the request that is
       * already holding Trilium's database.
       */
      expensive?: boolean;
      /** Share the response with identical in-flight GETs made with the same token. */
      dedupe?: boolean;
    } = {}
  ): Promise<T> {
    const {
      body,
      query,
      contentType = 'application/json',
      responseType = 'json',
      timeoutFactor = 1,
      expensive = false,
    } = options;

    let url = `${this.baseUrl}${path}`;

    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          params.append(key, String(value));
        }
      }
      const queryString = params.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    const headers: Record<string, string> = {
      Authorization: this.token,
    };

    if (body !== undefined) {
      headers['Content-Type'] = contentType;
    }

    const init: RequestInit = {
      method,
      headers,
      body:
        body !== undefined
          ? body instanceof Buffer || body instanceof Uint8Array
            ? body
            : contentType === 'application/json'
              ? JSON.stringify(body)
              : String(body)
          : undefined,
    };

    const send = (): Promise<T> =>
      this.send<T>(method, path, url, init, { responseType, timeoutFactor, expensive });
    if (options.dedupe && method === 'GET') {
      // Each caller gets its own copy: tool handlers decorate results in place.
      return dedupe(`${this.dedupeScope}|${url}`, send).then((value) => structuredClone(value));
    }
    return send();
  }

  private async send<T>(
    method: string,
    path: string,
    url: string,
    init: RequestInit,
    opts: {
      responseType: 'json' | 'text' | 'arraybuffer';
      timeoutFactor: number;
      expensive: boolean;
    }
  ): Promise<T> {
    const { responseType, timeoutFactor, expensive } = opts;
    const busyBefore = getBusy(this.baseUrl);
    if (busyBefore && expensive) {
      throw this.busyError(busyBefore);
    }
    const retries = IDEMPOTENT_METHODS.has(method) ? this.maxRetries : 0;
    const fullTimeoutMs = this.timeoutMs * timeoutFactor;
    // While the host is busy a cheap request gets a short leash: it either
    // squeezes through (and clears the flag) or fails fast instead of hanging.
    const timeoutMs = busyBefore ? Math.min(fullTimeoutMs, this.busyProbeTimeoutMs) : fullTimeoutMs;
    let response: Response;
    let attempt = 0;
    for (; ; attempt++) {
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        const timedOut =
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        // A timeout is not retried: the request may still be running server-side,
        // and waiting another full timeout rarely helps an LLM-facing call.
        if (!timedOut && attempt < retries) {
          await sleep(this.retryDelayMs * 2 ** attempt);
          continue;
        }
        if (timedOut) {
          throw this.onTimeout(
            busyBefore,
            `${method} ${path}`,
            `Trilium did not respond to ${method} ${path} within ${timeoutMs}ms`
          );
        }
        throw new TriliumClientError(
          503,
          'TRILIUM_UNREACHABLE',
          `Could not reach Trilium at ${this.baseUrl}: ${describeNetworkError(error)}`
        );
      }
      // Trilium itself answered, so whatever was holding it has finished.
      if (busyBefore && !RETRYABLE_STATUSES.has(response.status)) {
        clearBusy(this.baseUrl);
      }
      if (RETRYABLE_STATUSES.has(response.status) && attempt < retries) {
        await response.body?.cancel().catch(() => undefined);
        await sleep(this.retryDelayMs * 2 ** attempt);
        continue;
      }
      break;
    }

    // A retried DELETE whose first attempt landed (but whose response was lost)
    // now sees the entity gone. The caller's intent — "it should not exist" — holds.
    if (method === 'DELETE' && response.status === 404 && attempt > 0) {
      await response.body?.cancel().catch(() => undefined);
      return undefined as T;
    }

    if (!response.ok) {
      let errorData: Partial<EtapiError> = {};
      try {
        errorData = (await response.json()) as EtapiError;
      } catch {
        // Non-JSON error body (e.g. a reverse proxy's HTML page) — fall through.
      }
      throw new TriliumClientError(
        errorData.status ?? response.status,
        errorData.code ?? 'UNKNOWN_ERROR',
        errorData.message ?? (response.statusText || `HTTP ${response.status}`)
      );
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    // The timeout signal stays armed while the body streams, so a slow body
    // read aborts too — map it like a timeout on the request itself.
    try {
      if (responseType === 'text') {
        return (await response.text()) as T;
      }
      if (responseType === 'arraybuffer') {
        return (await response.arrayBuffer()) as T;
      }
      return (await response.json()) as T;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        throw this.onTimeout(
          busyBefore,
          `${method} ${path}`,
          `Trilium's response to ${method} ${path} did not finish within ${timeoutMs}ms`
        );
      }
      throw error;
    }
  }

  // ==================== Notes ====================

  async createNote(def: CreateNoteDef): Promise<NoteWithBranch> {
    return this.request<NoteWithBranch>('POST', '/create-note', { body: def });
  }

  async getNote(noteId: EntityId): Promise<Note> {
    return this.request<Note>('GET', `/notes/${noteId}`);
  }

  async getNoteContent(noteId: EntityId): Promise<string> {
    return this.request<string>('GET', `/notes/${noteId}/content`, { responseType: 'text' });
  }

  async updateNote(noteId: EntityId, patch: PatchNoteDef): Promise<Note> {
    return this.request<Note>('PATCH', `/notes/${noteId}`, { body: patch });
  }

  async updateNoteContent(noteId: EntityId, content: string): Promise<void> {
    await this.request<undefined>('PUT', `/notes/${noteId}/content`, {
      body: content,
      contentType: 'text/plain',
    });
  }

  async updateNoteContentBinary(noteId: EntityId, content: Buffer): Promise<void> {
    await this.request<undefined>('PUT', `/notes/${noteId}/content`, {
      body: content,
      contentType: 'application/octet-stream',
    });
  }

  async deleteNote(noteId: EntityId): Promise<void> {
    await this.request<undefined>('DELETE', `/notes/${noteId}`);
  }

  async undeleteNote(noteId: EntityId): Promise<UndeleteResponse> {
    return this.request<UndeleteResponse>('POST', `/notes/${noteId}/undelete`);
  }

  async getNoteAttachments(noteId: EntityId): Promise<Attachment[]> {
    return this.request<Attachment[]>('GET', `/notes/${noteId}/attachments`);
  }

  async getNoteHistory(ancestorNoteId?: EntityId): Promise<RecentChange[]> {
    return this.request<RecentChange[]>('GET', '/notes/history', {
      query: ancestorNoteId ? { ancestorNoteId } : undefined,
    });
  }

  // ==================== Search ====================

  async searchNotes(params: SearchParams): Promise<SearchResponse> {
    return this.request<SearchResponse>('GET', '/notes', {
      // Anything that reads note bodies is a LIKE scan over every note and
      // attachment on Trilium's single SQL thread. fastSearch skips that,
      // unless the query names note.content itself.
      expensive: !params.fastSearch || /note\.content/i.test(params.search),
      dedupe: true,
      query: {
        search: params.search,
        fastSearch: params.fastSearch,
        includeArchivedNotes: params.includeArchivedNotes,
        ancestorNoteId: params.ancestorNoteId,
        ancestorDepth: params.ancestorDepth,
        orderBy: params.orderBy,
        orderDirection: params.orderDirection,
        limit: params.limit,
        debug: params.debug,
      },
    });
  }

  // ==================== Branches ====================

  async createBranch(def: CreateBranchDef): Promise<Branch> {
    return this.request<Branch>('POST', '/branches', { body: def });
  }

  async getBranch(branchId: EntityId): Promise<Branch> {
    return this.request<Branch>('GET', `/branches/${branchId}`);
  }

  async updateBranch(branchId: EntityId, patch: PatchBranchDef): Promise<Branch> {
    return this.request<Branch>('PATCH', `/branches/${branchId}`, { body: patch });
  }

  async deleteBranch(branchId: EntityId): Promise<void> {
    await this.request<undefined>('DELETE', `/branches/${branchId}`);
  }

  async refreshNoteOrdering(parentNoteId: EntityId): Promise<void> {
    await this.request<undefined>('POST', `/refresh-note-ordering/${parentNoteId}`);
  }

  // ==================== Attributes ====================

  async createAttribute(def: CreateAttributeDef): Promise<Attribute> {
    return this.request<Attribute>('POST', '/attributes', { body: def });
  }

  async getAttribute(attributeId: EntityId): Promise<Attribute> {
    return this.request<Attribute>('GET', `/attributes/${attributeId}`);
  }

  async updateAttribute(attributeId: EntityId, patch: PatchAttributeDef): Promise<Attribute> {
    return this.request<Attribute>('PATCH', `/attributes/${attributeId}`, { body: patch });
  }

  async deleteAttribute(attributeId: EntityId): Promise<void> {
    await this.request<undefined>('DELETE', `/attributes/${attributeId}`);
  }

  // ==================== Calendar ====================

  async getDayNote(date: string): Promise<Note> {
    return this.request<Note>('GET', `/calendar/days/${date}`);
  }

  async getWeekNote(week: string): Promise<Note> {
    return this.request<Note>('GET', `/calendar/weeks/${week}`);
  }

  async getMonthNote(month: string): Promise<Note> {
    return this.request<Note>('GET', `/calendar/months/${month}`);
  }

  async getYearNote(year: string): Promise<Note> {
    return this.request<Note>('GET', `/calendar/years/${year}`);
  }

  /** Day note for the first day of the week containing `date` (honours the configured first weekday). */
  async getWeekFirstDayNote(date: string): Promise<Note> {
    return this.request<Note>('GET', `/calendar/week-first-day/${date}`);
  }

  async getInboxNote(date: string): Promise<Note> {
    return this.request<Note>('GET', `/inbox/${date}`);
  }

  // ==================== App Info ====================

  async getAppInfo(): Promise<AppInfo> {
    return this.request<AppInfo>('GET', '/app-info');
  }

  /** Instance/database counts (no titles or content). Requires a Trilium with /etapi/metrics. */
  async getMetrics(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/metrics', {
      query: { format: 'json' },
    });
  }

  // ==================== Revisions ====================

  async createRevision(noteId: EntityId, format: 'html' | 'markdown' = 'html'): Promise<void> {
    await this.request<undefined>('POST', `/notes/${noteId}/revision`, {
      query: { format },
    });
  }

  async getNoteRevisions(noteId: EntityId): Promise<Revision[]> {
    return this.request<Revision[]>('GET', `/notes/${noteId}/revisions`);
  }

  async getRevision(revisionId: EntityId): Promise<Revision> {
    return this.request<Revision>('GET', `/revisions/${revisionId}`);
  }

  async getRevisionContent(revisionId: EntityId): Promise<string> {
    return this.request<string>('GET', `/revisions/${revisionId}/content`, {
      responseType: 'text',
    });
  }

  async getRevisionContentBinary(revisionId: EntityId): Promise<Buffer> {
    const buffer = await this.request<ArrayBuffer>('GET', `/revisions/${revisionId}/content`, {
      responseType: 'arraybuffer',
    });
    return Buffer.from(buffer);
  }

  // ==================== Backup ====================

  async createBackup(backupName: string): Promise<void> {
    await this.request<undefined>('PUT', `/backup/${backupName}`, { timeoutFactor: 5 });
  }

  // ==================== Export / Import ====================

  async exportNote(noteId: EntityId, format: 'html' | 'markdown' = 'html'): Promise<ArrayBuffer> {
    return this.request<ArrayBuffer>('GET', `/notes/${noteId}/export`, {
      query: { format },
      responseType: 'arraybuffer',
      timeoutFactor: 5,
    });
  }

  async importZip(noteId: EntityId, data: Buffer): Promise<NoteWithBranch> {
    return this.request<NoteWithBranch>('POST', `/notes/${noteId}/import`, {
      body: data,
      contentType: 'application/octet-stream',
      timeoutFactor: 5,
    });
  }

  // ==================== Attachments ====================

  async createAttachment(def: CreateAttachmentDef): Promise<Attachment> {
    return this.request<Attachment>('POST', '/attachments', { body: def });
  }

  async getAttachment(attachmentId: EntityId): Promise<Attachment> {
    return this.request<Attachment>('GET', `/attachments/${attachmentId}`);
  }

  async updateAttachment(attachmentId: EntityId, patch: PatchAttachmentDef): Promise<Attachment> {
    return this.request<Attachment>('PATCH', `/attachments/${attachmentId}`, { body: patch });
  }

  async deleteAttachment(attachmentId: EntityId): Promise<void> {
    await this.request<undefined>('DELETE', `/attachments/${attachmentId}`);
  }

  async getAttachmentContent(attachmentId: EntityId): Promise<string> {
    return this.request<string>('GET', `/attachments/${attachmentId}/content`, {
      responseType: 'text',
    });
  }

  async getAttachmentContentAsBase64(attachmentId: EntityId): Promise<string> {
    const buffer = await this.request<ArrayBuffer>('GET', `/attachments/${attachmentId}/content`, {
      responseType: 'arraybuffer',
    });
    const bytes = new Uint8Array(buffer);

    // Use file-type library to detect if content is raw binary image
    // vs already base64-encoded text (created via ETAPI)
    const fileType = await fileTypeFromBuffer(bytes);

    if (fileType && fileType.mime.startsWith('image/')) {
      // Content is raw binary - convert to base64
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }

    // Content is already base64-encoded (stored as text via ETAPI)
    // Just decode the bytes as UTF-8 text
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(buffer);
  }

  async updateAttachmentContent(attachmentId: EntityId, content: string): Promise<void> {
    await this.request<undefined>('PUT', `/attachments/${attachmentId}/content`, {
      body: content,
      contentType: 'text/plain',
    });
  }

  async updateAttachmentContentBinary(attachmentId: EntityId, content: Buffer): Promise<void> {
    await this.request<undefined>('PUT', `/attachments/${attachmentId}/content`, {
      body: content,
      contentType: 'application/octet-stream',
    });
  }
}
