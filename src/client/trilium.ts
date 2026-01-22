import { fileTypeFromBuffer } from 'file-type';
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
} from '../types/etapi.js';

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

export class TriliumClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    // Remove trailing slash if present
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      contentType?: string;
      responseType?: 'json' | 'text' | 'arraybuffer';
    } = {}
  ): Promise<T> {
    const { body, query, contentType = 'application/json', responseType = 'json' } = options;

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

    const response = await fetch(url, {
      method,
      headers,
      body:
        body !== undefined
          ? contentType === 'application/json'
            ? JSON.stringify(body)
            : String(body)
          : undefined,
    });

    if (!response.ok) {
      let errorData: EtapiError;
      try {
        errorData = (await response.json()) as EtapiError;
      } catch {
        errorData = {
          status: response.status,
          code: 'UNKNOWN_ERROR',
          message: response.statusText,
        };
      }
      throw new TriliumClientError(errorData.status, errorData.code, errorData.message);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    if (responseType === 'text') {
      return (await response.text()) as T;
    }

    if (responseType === 'arraybuffer') {
      return (await response.arrayBuffer()) as T;
    }

    return (await response.json()) as T;
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

  async deleteNote(noteId: EntityId): Promise<void> {
    await this.request<undefined>('DELETE', `/notes/${noteId}`);
  }

  // ==================== Search ====================

  async searchNotes(params: SearchParams): Promise<SearchResponse> {
    return this.request<SearchResponse>('GET', '/notes', {
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

  async getInboxNote(date: string): Promise<Note> {
    return this.request<Note>('GET', `/inbox/${date}`);
  }

  // ==================== App Info ====================

  async getAppInfo(): Promise<AppInfo> {
    return this.request<AppInfo>('GET', '/app-info');
  }

  // ==================== Revisions ====================

  async createRevision(noteId: EntityId, format: 'html' | 'markdown' = 'html'): Promise<void> {
    await this.request<undefined>('POST', `/notes/${noteId}/revision`, {
      query: { format },
    });
  }

  // ==================== Backup ====================

  async createBackup(backupName: string): Promise<void> {
    await this.request<undefined>('PUT', `/backup/${backupName}`);
  }

  // ==================== Export ====================

  async exportNote(noteId: EntityId, format: 'html' | 'markdown' = 'html'): Promise<ArrayBuffer> {
    const url = `${this.baseUrl}/notes/${noteId}/export?format=${format}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: this.token,
      },
    });

    if (!response.ok) {
      throw new TriliumClientError(
        response.status,
        'EXPORT_ERROR',
        `Failed to export note: ${response.statusText}`
      );
    }

    return response.arrayBuffer();
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
}
