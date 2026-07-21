import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerNoteTools, handleNoteTool } from '../../src/tools/notes.js';
import { registerSearchTools, handleSearchTool } from '../../src/tools/search.js';
import { registerOrganizationTools, handleOrganizationTool } from '../../src/tools/organization.js';
import { registerAttributeTools, handleAttributeTool } from '../../src/tools/attributes.js';
import { registerCalendarTools, handleCalendarTool, isoWeekString } from '../../src/tools/calendar.js';
import { registerSystemTools, handleSystemTool } from '../../src/tools/system.js';
import {
  registerAttachmentTools,
  handleAttachmentTool,
  isBinaryMimeType,
} from '../../src/tools/attachments.js';
import { registerRevisionTools, handleRevisionTool } from '../../src/tools/revisions.js';
import type { TriliumClient } from '../../src/client/trilium.js';
import { TriliumClientError } from '../../src/client/trilium.js';
import { NOTE_TYPES } from '../../src/tools/validators.js';

// ============================================================================
// Mock client factory
// ============================================================================

function createMockClient(overrides: Partial<TriliumClient> = {}): TriliumClient {
  return {
    createNote: vi.fn(),
    getNote: vi.fn(),
    getNoteUrl: vi.fn().mockResolvedValue('http://localhost:37740/#root/n1'),
    getNoteContent: vi.fn(),
    updateNote: vi.fn(),
    updateNoteContent: vi.fn(),
    deleteNote: vi.fn(),
    undeleteNote: vi.fn(),
    getNoteAttachments: vi.fn(),
    getNoteHistory: vi.fn(),
    searchNotes: vi.fn(),
    createBranch: vi.fn(),
    getBranch: vi.fn(),
    updateBranch: vi.fn(),
    deleteBranch: vi.fn(),
    refreshNoteOrdering: vi.fn(),
    createAttribute: vi.fn(),
    getAttribute: vi.fn(),
    updateAttribute: vi.fn(),
    deleteAttribute: vi.fn(),
    getDayNote: vi.fn(),
    getWeekNote: vi.fn(),
    getMonthNote: vi.fn(),
    getYearNote: vi.fn(),
    getInboxNote: vi.fn(),
    getAppInfo: vi.fn(),
    importZip: vi.fn(),
    createRevision: vi.fn(),
    getNoteRevisions: vi.fn(),
    getRevision: vi.fn(),
    getRevisionContent: vi.fn(),
    createBackup: vi.fn(),
    exportNote: vi.fn(),
    createAttachment: vi.fn(),
    getAttachment: vi.fn(),
    updateAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
    getAttachmentContent: vi.fn(),
    getAttachmentContentAsBase64: vi.fn(),
    updateAttachmentContent: vi.fn(),
    updateAttachmentContentBinary: vi.fn(),
    updateNoteContentBinary: vi.fn(),
    ...overrides,
  } as unknown as TriliumClient;
}

// ============================================================================
// Utility / type tests
// ============================================================================

describe('NOTE_TYPES', () => {
  it('contains the 18 note types Trilium supports', () => {
    expect(NOTE_TYPES).toHaveLength(18);
    expect(new Set(NOTE_TYPES)).toEqual(
      new Set([
        'text',
        'code',
        'render',
        'file',
        'image',
        'search',
        'relationMap',
        'book',
        'noteMap',
        'mermaid',
        'canvas',
        'mindMap',
        'geoMap',
        'webView',
        'shortcut',
        'doc',
        'contentWidget',
        'launcher',
      ])
    );
  });
});

describe('isBinaryMimeType', () => {
  it('is true for binary MIMEs', () => {
    expect(isBinaryMimeType('image/png')).toBe(true);
    expect(isBinaryMimeType('image/jpeg')).toBe(true);
    expect(isBinaryMimeType('application/pdf')).toBe(true);
    expect(isBinaryMimeType('application/octet-stream')).toBe(true);
  });

  it('is false for text MIMEs', () => {
    expect(isBinaryMimeType('text/plain')).toBe(false);
    expect(isBinaryMimeType('text/html')).toBe(false);
    expect(isBinaryMimeType('application/json')).toBe(false);
    expect(isBinaryMimeType('application/javascript')).toBe(false);
    expect(isBinaryMimeType('image/svg+xml')).toBe(false);
  });
});

// ============================================================================
// Notes
// ============================================================================

describe('Note tools', () => {
  describe('registration', () => {
    it('registers 5 tools with reads first', () => {
      const tools = registerNoteTools();
      expect(tools.map((t) => t.name)).toEqual([
        'get_note',
        'get_note_history',
        'create_note',
        'write_note',
        'delete_note',
      ]);
    });

    it('sets annotations on every tool', () => {
      const tools = registerNoteTools();
      for (const t of tools) {
        expect(t.annotations).toBeDefined();
        expect(t.annotations?.title).toBeTruthy();
      }
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName['get_note'].annotations?.readOnlyHint).toBe(true);
      expect(byName['get_note_history'].annotations?.readOnlyHint).toBe(true);
      expect(byName['create_note'].annotations?.readOnlyHint).toBe(false);
      expect(byName['write_note'].annotations?.destructiveHint).toBe(true);
      expect(byName['delete_note'].annotations?.destructiveHint).toBe(true);
      expect(byName['delete_note'].annotations?.idempotentHint).toBe(true);
    });
  });

  describe('create_note', () => {
    let client: TriliumClient;
    beforeEach(() => {
      client = createMockClient();
    });

    it('creates a text note', async () => {
      const expected = {
        note: { noteId: 'n1', title: 'T' },
        branch: { branchId: 'b1', parentNoteId: 'root' },
      };
      (client.createNote as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'T',
        type: 'text',
        content: '<p>hi</p>',
      });

      expect(client.createNote).toHaveBeenCalled();
      expect(result?.content[0]).toMatchObject({ type: 'text' });
    });

    it('includes the note url in the response', async () => {
      (client.createNote as ReturnType<typeof vi.fn>).mockResolvedValue({
        note: { noteId: 'n1', title: 'T' },
        branch: { branchId: 'b1', parentNoteId: 'root' },
      });
      (client.getNoteUrl as ReturnType<typeof vi.fn>).mockResolvedValue(
        'http://localhost:37740/#root/n1'
      );

      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'T',
        type: 'text',
        content: '<p>hi</p>',
      });

      expect(client.getNoteUrl).toHaveBeenCalledWith('n1', 'root');
      const payload = JSON.parse((result?.content[0] as { text: string }).text);
      expect(payload.url).toBe('http://localhost:37740/#root/n1');
    });

    it('requires parentNoteId / title / type / content', async () => {
      await expect(handleNoteTool(client, 'create_note', {})).rejects.toThrow();
    });

    it('converts markdown to HTML when format="markdown"', async () => {
      (client.createNote as ReturnType<typeof vi.fn>).mockResolvedValue({
        note: { noteId: 'n1' },
        branch: { branchId: 'b1' },
      });

      await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'T',
        type: 'text',
        content: '# heading',
        format: 'markdown',
      });

      const call = (client.createNote as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.content).toContain('<h1');
    });
  });

  describe('get_note', () => {
    let client: TriliumClient;
    beforeEach(() => {
      client = createMockClient();
    });

    it('fetches content by default (include_content omitted)', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'n1', title: 'T' });
      (client.getNoteContent as ReturnType<typeof vi.fn>).mockResolvedValue('<p>body</p>');
      (client.getNoteAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await handleNoteTool(client, 'get_note', { noteId: 'n1' });

      expect(client.getNote).toHaveBeenCalledWith('n1');
      expect(client.getNoteContent).toHaveBeenCalledWith('n1');
      expect(result?.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('body') });
    });

    it('returns a metadata block (with contentInfo) before the content block', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'n1', title: 'T' });
      (client.getNoteContent as ReturnType<typeof vi.fn>).mockResolvedValue('hello');
      (client.getNoteAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await handleNoteTool(client, 'get_note', { noteId: 'n1' });

      const meta = JSON.parse((result?.content[0] as { text: string }).text);
      expect(meta.title).toBe('T');
      expect(meta.contentInfo.totalChars).toBe(5);
      expect(meta.contentInfo.truncated).toBe(false);
      expect((result?.content[1] as { text: string }).text).toBe('hello');
    });

    it('truncates content over content_max_chars and appends a continuation notice', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'n1', title: 'T' });
      (client.getNoteContent as ReturnType<typeof vi.fn>).mockResolvedValue('a'.repeat(100));
      (client.getNoteAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await handleNoteTool(client, 'get_note', {
        noteId: 'n1',
        content_max_chars: 10,
      });

      const meta = JSON.parse((result?.content[0] as { text: string }).text);
      expect(meta.contentInfo).toMatchObject({ totalChars: 100, returnedEnd: 10, truncated: true });
      const body = (result?.content[1] as { text: string }).text;
      expect(body.startsWith('a'.repeat(10))).toBe(true);
      expect(body).toContain('truncated');
      expect(body).toContain('content_start');
    });

    it('content_start pages through content', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'n1' });
      (client.getNoteContent as ReturnType<typeof vi.fn>).mockResolvedValue('0123456789');
      (client.getNoteAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await handleNoteTool(client, 'get_note', {
        noteId: 'n1',
        content_start: 4,
        content_max_chars: 3,
      });

      const meta = JSON.parse((result?.content[0] as { text: string }).text);
      expect(meta.contentInfo).toMatchObject({ returnedStart: 4, returnedEnd: 7, totalChars: 10 });
      const body = (result?.content[1] as { text: string }).text;
      expect(body.startsWith('456')).toBe(true);
    });

    it('caps content at 50k chars by default', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'n1' });
      (client.getNoteContent as ReturnType<typeof vi.fn>).mockResolvedValue('x'.repeat(60_000));
      (client.getNoteAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await handleNoteTool(client, 'get_note', { noteId: 'n1' });

      const meta = JSON.parse((result?.content[0] as { text: string }).text);
      expect(meta.contentInfo).toMatchObject({ totalChars: 60_000, returnedEnd: 50_000, truncated: true });
    });

    it('returns metadata only when include_content=false', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'n1', title: 'T' });

      const result = await handleNoteTool(client, 'get_note', {
        noteId: 'n1',
        include_content: false,
      });

      expect(client.getNote).toHaveBeenCalledWith('n1');
      expect(client.getNoteContent).not.toHaveBeenCalled();
      expect(result?.content[0]).toMatchObject({ type: 'text' });
    });

    it('fetches content when include_content=true', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'n1' });
      (client.getNoteContent as ReturnType<typeof vi.fn>).mockResolvedValue('<p>body</p>');
      (client.getNoteAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await handleNoteTool(client, 'get_note', {
        noteId: 'n1',
        include_content: true,
      });

      expect(client.getNoteContent).toHaveBeenCalledWith('n1');
      expect(result?.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('body') });
    });

    it('converts HTML to markdown when format="markdown" + include_content=true', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'n1' });
      (client.getNoteContent as ReturnType<typeof vi.fn>).mockResolvedValue('<h1>Title</h1>');
      (client.getNoteAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await handleNoteTool(client, 'get_note', {
        noteId: 'n1',
        include_content: true,
        format: 'markdown',
      });

      const text = (result?.content[1] as { text: string }).text;
      expect(text).toContain('# Title');
    });

    it('skips image fetching when includeImages=false', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'n1' });
      (client.getNoteContent as ReturnType<typeof vi.fn>).mockResolvedValue('<p>x</p>');

      await handleNoteTool(client, 'get_note', {
        noteId: 'n1',
        include_content: true,
        includeImages: false,
      });

      expect(client.getNoteAttachments).not.toHaveBeenCalled();
    });
  });

  describe('write_note', () => {
    let client: TriliumClient;
    beforeEach(() => {
      client = createMockClient();
    });

    it('mode="metadata" calls updateNote with patch', async () => {
      (client.updateNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'n1', title: 'New' });

      await handleNoteTool(client, 'write_note', {
        noteId: 'n1',
        mode: 'metadata',
        title: 'New',
      });

      expect(client.updateNote).toHaveBeenCalledWith('n1', { title: 'New' });
    });

    it('includes the note url in every write mode', async () => {
      (client.updateNote as ReturnType<typeof vi.fn>).mockResolvedValue({
        noteId: 'n1',
        title: 'New',
        parentNoteIds: ['root'],
      });
      (client.updateNoteContent as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (client.getNoteUrl as ReturnType<typeof vi.fn>).mockResolvedValue(
        'http://localhost:37740/#root/n1'
      );

      const meta = await handleNoteTool(client, 'write_note', {
        noteId: 'n1',
        mode: 'metadata',
        title: 'New',
      });
      expect(JSON.parse((meta?.content[0] as { text: string }).text).url).toBe(
        'http://localhost:37740/#root/n1'
      );

      const replace = await handleNoteTool(client, 'write_note', {
        noteId: 'n1',
        mode: 'replace',
        content: '<p>x</p>',
      });
      expect(JSON.parse((replace?.content[0] as { text: string }).text).url).toBe(
        'http://localhost:37740/#root/n1'
      );
    });

    it('mode="metadata" requires at least one of title/type/mime', async () => {
      await expect(
        handleNoteTool(client, 'write_note', { noteId: 'n1', mode: 'metadata' })
      ).rejects.toThrow();
    });

    it('mode="replace" overwrites content', async () => {
      (client.updateNoteContent as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await handleNoteTool(client, 'write_note', {
        noteId: 'n1',
        mode: 'replace',
        content: '<p>new body</p>',
      });

      expect(client.getNoteContent).not.toHaveBeenCalled();
      expect(client.updateNoteContent).toHaveBeenCalledWith('n1', '<p>new body</p>');
    });

    it('mode="replace" requires content', async () => {
      await expect(
        handleNoteTool(client, 'write_note', { noteId: 'n1', mode: 'replace' })
      ).rejects.toThrow();
    });

    it('mode="append" fetches existing and concatenates', async () => {
      (client.getNoteContent as ReturnType<typeof vi.fn>).mockResolvedValue('<p>existing</p>');
      (client.updateNoteContent as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await handleNoteTool(client, 'write_note', {
        noteId: 'n1',
        mode: 'append',
        content: '<p>more</p>',
      });

      expect(client.getNoteContent).toHaveBeenCalledWith('n1');
      expect(client.updateNoteContent).toHaveBeenCalledWith('n1', '<p>existing</p><p>more</p>');
    });

    it('mode="edit" with changes applies search/replace', async () => {
      // Simulate persistence: first read returns pre-edit, subsequent reads return post-edit
      let stored = '<p>hello world</p>';
      (client.getNoteContent as ReturnType<typeof vi.fn>).mockImplementation(async () => stored);
      (client.updateNoteContent as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, body: string) => {
          stored = body;
        }
      );

      await handleNoteTool(client, 'write_note', {
        noteId: 'n1',
        mode: 'edit',
        changes: [{ old_string: 'hello', new_string: 'hi' }],
      });

      expect(client.updateNoteContent).toHaveBeenCalledWith('n1', '<p>hi world</p>');
    });

    it('mode="edit" requires exactly one of changes/patch', async () => {
      await expect(
        handleNoteTool(client, 'write_note', { noteId: 'n1', mode: 'edit' })
      ).rejects.toThrow();

      await expect(
        handleNoteTool(client, 'write_note', {
          noteId: 'n1',
          mode: 'edit',
          changes: [{ old_string: 'a', new_string: 'b' }],
          patch: '@@',
        })
      ).rejects.toThrow();
    });

    it('mode="edit" rejects format="markdown"', async () => {
      await expect(
        handleNoteTool(client, 'write_note', {
          noteId: 'n1',
          mode: 'edit',
          changes: [{ old_string: 'a', new_string: 'b' }],
          format: 'markdown',
        })
      ).rejects.toThrow();
    });

    it('mode="edit" rejects content field', async () => {
      await expect(
        handleNoteTool(client, 'write_note', {
          noteId: 'n1',
          mode: 'edit',
          changes: [{ old_string: 'a', new_string: 'b' }],
          content: 'x',
        })
      ).rejects.toThrow();
    });

    it('mode="metadata" rejects content', async () => {
      await expect(
        handleNoteTool(client, 'write_note', {
          noteId: 'n1',
          mode: 'metadata',
          title: 'T',
          content: 'x',
        })
      ).rejects.toThrow();
    });

    it('mode="replace" rejects title (metadata fields)', async () => {
      await expect(
        handleNoteTool(client, 'write_note', {
          noteId: 'n1',
          mode: 'replace',
          content: 'x',
          title: 'T',
        })
      ).rejects.toThrow();
    });

    it('rejects unknown mode', async () => {
      await expect(
        handleNoteTool(client, 'write_note', { noteId: 'n1', mode: 'bogus' })
      ).rejects.toThrow();
    });
  });

  describe('delete_note', () => {
    let client: TriliumClient;
    beforeEach(() => {
      client = createMockClient();
    });

    it('action="delete" deletes the note', async () => {
      await handleNoteTool(client, 'delete_note', { noteId: 'n1', action: 'delete' });
      expect(client.deleteNote).toHaveBeenCalledWith('n1');
      expect(client.undeleteNote).not.toHaveBeenCalled();
    });

    it('action="undelete" restores the note', async () => {
      (client.undeleteNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'n1' });
      await handleNoteTool(client, 'delete_note', { noteId: 'n1', action: 'undelete' });
      expect(client.undeleteNote).toHaveBeenCalledWith('n1');
      expect(client.deleteNote).not.toHaveBeenCalled();
    });

    it('rejects missing action (required, no default)', async () => {
      await expect(handleNoteTool(client, 'delete_note', { noteId: 'n1' })).rejects.toThrow();
    });

    it('rejects unknown action', async () => {
      await expect(
        handleNoteTool(client, 'delete_note', { noteId: 'n1', action: 'purge' })
      ).rejects.toThrow();
    });
  });

  describe('get_note_history', () => {
    it('returns history with no ancestor filter', async () => {
      const client = createMockClient();
      (client.getNoteHistory as ReturnType<typeof vi.fn>).mockResolvedValue([{ noteId: 'n1' }]);
      await handleNoteTool(client, 'get_note_history', {});
      expect(client.getNoteHistory).toHaveBeenCalledWith(undefined);
    });

    it('passes ancestorNoteId through', async () => {
      const client = createMockClient();
      (client.getNoteHistory as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await handleNoteTool(client, 'get_note_history', { ancestorNoteId: 'root' });
      expect(client.getNoteHistory).toHaveBeenCalledWith('root');
    });
  });
});

// ============================================================================
// Search
// ============================================================================

describe('Search tools', () => {
  it('registers 2 tools with read annotations', () => {
    const tools = registerSearchTools();
    expect(tools.map((t) => t.name)).toEqual(['search_notes', 'get_note_tree']);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('search_notes calls client.searchNotes', async () => {
    const client = createMockClient();
    (client.searchNotes as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    await handleSearchTool(client, 'search_notes', { query: 'test' });
    expect(client.searchNotes).toHaveBeenCalled();
  });

  it('search_notes exposes and forwards ancestorDepth and debug', async () => {
    const [searchTool] = registerSearchTools();
    const props = searchTool.inputSchema.properties as Record<string, unknown>;
    expect(props.ancestorDepth).toBeDefined();
    expect(props.debug).toBeDefined();

    const client = createMockClient();
    (client.searchNotes as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    await handleSearchTool(client, 'search_notes', {
      query: 'test',
      ancestorNoteId: 'n1',
      ancestorDepth: 'eq1',
      debug: true,
    });
    expect(client.searchNotes).toHaveBeenCalledWith(
      expect.objectContaining({ ancestorDepth: 'eq1', debug: true })
    );
  });

  it('search_notes forwards ancestorDepth and debug on the noteId-lookup 404 fallback path', async () => {
    const client = createMockClient();
    (client.getNote as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TriliumClientError(404, 'NOTE_NOT_FOUND', 'not found')
    );
    (client.searchNotes as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    await handleSearchTool(client, 'search_notes', {
      query: 'abc123def456',
      ancestorDepth: 'lt2',
      debug: true,
    });
    expect(client.getNote).toHaveBeenCalledWith('abc123def456');
    expect(client.searchNotes).toHaveBeenCalledWith(
      expect.objectContaining({ ancestorDepth: 'lt2', debug: true })
    );
  });

  describe('get_note_tree', () => {
    function treeMock(notes: Record<string, { title: string; childNoteIds?: string[] }>) {
      const client = createMockClient();
      (client.getNote as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
        const n = notes[id];
        if (!n) return Promise.reject(new TriliumClientError(404, 'NOTE_NOT_FOUND', `${id} not found`));
        return Promise.resolve({
          noteId: id,
          title: n.title,
          type: 'text',
          childNoteIds: n.childNoteIds ?? [],
          childBranchIds: (n.childNoteIds ?? []).map((c) => `b-${c}`),
        });
      });
      return client;
    }

    async function callTree(client: TriliumClient, args: Record<string, unknown>) {
      const result = await handleSearchTool(client, 'get_note_tree', args);
      return JSON.parse((result?.content[0] as { text: string }).text);
    }

    it('returns children with titles at default depth 1', async () => {
      const client = treeMock({
        root: { title: 'Root', childNoteIds: ['c1', 'c2'] },
        c1: { title: 'Alpha', childNoteIds: ['g1'] },
        c2: { title: 'Beta' },
      });
      const tree = await callTree(client, { noteId: 'root' });
      expect(tree.title).toBe('Root');
      expect(tree.children).toHaveLength(2);
      expect(tree.children[0]).toMatchObject({ noteId: 'c1', title: 'Alpha', childCount: 1 });
      // boundary node: grandchildren not fetched, but IDs available for drilling
      expect(tree.children[0].children).toBeUndefined();
      expect(tree.children[0].childNoteIds).toEqual(['g1']);
    });

    it('depth=2 expands grandchildren', async () => {
      const client = treeMock({
        root: { title: 'Root', childNoteIds: ['c1'] },
        c1: { title: 'Alpha', childNoteIds: ['g1'] },
        g1: { title: 'Grandchild' },
      });
      const tree = await callTree(client, { noteId: 'root', depth: 2 });
      expect(tree.children[0].children[0]).toMatchObject({ noteId: 'g1', title: 'Grandchild' });
    });

    it('skips _-prefixed system children unless the requested root is itself a system note', async () => {
      const client = treeMock({
        root: { title: 'Root', childNoteIds: ['c1', '_hidden'] },
        c1: { title: 'Alpha' },
        _hidden: { title: 'Hidden', childNoteIds: ['_sub'] },
        _sub: { title: 'Sub' },
      });
      const tree = await callTree(client, { noteId: 'root' });
      expect(tree.children).toHaveLength(1);
      expect(tree.children[0].noteId).toBe('c1');

      const hiddenTree = await callTree(client, { noteId: '_hidden' });
      expect(hiddenTree.children).toHaveLength(1);
      expect(hiddenTree.children[0].noteId).toBe('_sub');
    });

    it('a failed child fetch yields a stub node instead of failing the call', async () => {
      const client = treeMock({
        root: { title: 'Root', childNoteIds: ['c1', 'missing'] },
        c1: { title: 'Alpha' },
      });
      const tree = await callTree(client, { noteId: 'root' });
      expect(tree.children).toHaveLength(2);
      expect(tree.children[1].noteId).toBe('missing');
      expect(tree.children[1].error).toContain('not found');
    });

    it('caps total fetched notes and marks the response truncated', async () => {
      const many = Array.from({ length: 250 }, (_, i) => `c${i}`);
      const notes: Record<string, { title: string; childNoteIds?: string[] }> = {
        root: { title: 'Root', childNoteIds: many },
      };
      for (const id of many) notes[id] = { title: `Note ${id}` };
      const client = treeMock(notes);
      const tree = await callTree(client, { noteId: 'root' });
      expect(tree.children.length).toBeLessThanOrEqual(200);
      expect(tree.truncated).toBe(true);
    });

    it('rejects depth outside 1-5', async () => {
      const client = treeMock({ root: { title: 'Root' } });
      await expect(handleSearchTool(client, 'get_note_tree', { noteId: 'root', depth: 9 })).rejects.toThrow();
    });
  });
});

// ============================================================================
// Organization
// ============================================================================

describe('Organization tools', () => {
  it('registers 1 tool (organize_note)', () => {
    const tools = registerOrganizationTools();
    expect(tools.map((t) => t.name)).toEqual(['organize_note']);
    expect(tools[0].annotations?.destructiveHint).toBe(true);
  });

  let client: TriliumClient;
  beforeEach(() => {
    client = createMockClient();
  });

  describe('organize_note', () => {
    it('action="move" creates new branch then deletes old', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({
        noteId: 'n1',
        parentBranchIds: ['old-b'],
      });
      (client.createBranch as ReturnType<typeof vi.fn>).mockResolvedValue({ branchId: 'new-b' });

      await handleOrganizationTool(client, 'organize_note', {
        action: 'move',
        noteId: 'n1',
        newParentNoteId: 'newParent',
      });

      expect(client.createBranch).toHaveBeenCalled();
      expect(client.deleteBranch).toHaveBeenCalledWith('old-b');
    });

    it('action="move" returns a url for the new location', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({
        noteId: 'n1',
        parentBranchIds: ['old-b'],
      });
      (client.createBranch as ReturnType<typeof vi.fn>).mockResolvedValue({
        branchId: 'new-b',
        parentNoteId: 'newParent',
      });
      (client.getNoteUrl as ReturnType<typeof vi.fn>).mockResolvedValue(
        'http://localhost:37740/#root/newParent/n1'
      );

      const result = await handleOrganizationTool(client, 'organize_note', {
        action: 'move',
        noteId: 'n1',
        newParentNoteId: 'newParent',
      });

      expect(client.getNoteUrl).toHaveBeenCalledWith('n1', 'newParent');
      expect(JSON.parse((result?.content[0] as { text: string }).text).url).toBe(
        'http://localhost:37740/#root/newParent/n1'
      );
    });

    it('action="move" requires noteId + newParentNoteId', async () => {
      await expect(
        handleOrganizationTool(client, 'organize_note', { action: 'move', noteId: 'n1' })
      ).rejects.toThrow();
    });

    it('action="clone" creates a branch', async () => {
      (client.createBranch as ReturnType<typeof vi.fn>).mockResolvedValue({ branchId: 'b1' });
      await handleOrganizationTool(client, 'organize_note', {
        action: 'clone',
        noteId: 'n1',
        parentNoteId: 'p1',
      });
      expect(client.createBranch).toHaveBeenCalledWith({
        noteId: 'n1',
        parentNoteId: 'p1',
        prefix: undefined,
      });
    });

    it('action="clone" requires noteId + parentNoteId', async () => {
      await expect(
        handleOrganizationTool(client, 'organize_note', { action: 'clone', noteId: 'n1' })
      ).rejects.toThrow();
    });

    it('action="reorder" updates each branch position', async () => {
      (client.updateBranch as ReturnType<typeof vi.fn>).mockResolvedValue({ branchId: 'b1' });

      await handleOrganizationTool(client, 'organize_note', {
        action: 'reorder',
        parentNoteId: 'p1',
        notePositions: [
          { branchId: 'b1', notePosition: 10 },
          { branchId: 'b2', notePosition: 20 },
        ],
      });

      expect(client.updateBranch).toHaveBeenCalledTimes(2);
      expect(client.refreshNoteOrdering).toHaveBeenCalledWith('p1');
    });

    it('action="reorder" requires parentNoteId and non-empty notePositions', async () => {
      await expect(
        handleOrganizationTool(client, 'organize_note', {
          action: 'reorder',
          parentNoteId: 'p1',
          notePositions: [],
        })
      ).rejects.toThrow();
    });

    it('action="unlink" deletes the specified branch', async () => {
      await handleOrganizationTool(client, 'organize_note', {
        action: 'unlink',
        branchId: 'b1',
      });
      expect(client.deleteBranch).toHaveBeenCalledWith('b1');
    });

    it('action="unlink" requires branchId', async () => {
      await expect(
        handleOrganizationTool(client, 'organize_note', { action: 'unlink' })
      ).rejects.toThrow();
    });

    it('rejects unknown action', async () => {
      await expect(
        handleOrganizationTool(client, 'organize_note', { action: 'bogus' })
      ).rejects.toThrow();
    });
  });
});

// ============================================================================
// Attributes
// ============================================================================

describe('Attribute tools', () => {
  it('registers 3 tools', () => {
    const tools = registerAttributeTools();
    expect(tools.map((t) => t.name)).toEqual([
      'get_attributes',
      'set_attribute',
      'delete_attribute',
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName['get_attributes'].annotations?.readOnlyHint).toBe(true);
    // Not idempotent since mode="add": a retried call would create a duplicate attribute
    expect(byName['set_attribute'].annotations?.idempotentHint).toBe(false);
    expect(byName['delete_attribute'].annotations?.destructiveHint).toBe(true);
  });

  let client: TriliumClient;
  beforeEach(() => {
    client = createMockClient();
  });

  describe('get_attributes', () => {
    it('returns grouped attributes when given noteId', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({
        noteId: 'n1',
        attributes: [
          { attributeId: 'a1', type: 'label', name: 'foo', value: 'bar' },
          { attributeId: 'a2', type: 'relation', name: 'links', value: 'n2' },
        ],
      });

      const result = await handleAttributeTool(client, 'get_attributes', { noteId: 'n1' });
      const parsed = JSON.parse((result?.content[0] as { text: string }).text);
      expect(parsed.labels).toHaveLength(1);
      expect(parsed.relations).toHaveLength(1);
    });

    it('returns single attribute when given attributeId', async () => {
      (client.getAttribute as ReturnType<typeof vi.fn>).mockResolvedValue({ attributeId: 'a1' });
      await handleAttributeTool(client, 'get_attributes', { attributeId: 'a1' });
      expect(client.getAttribute).toHaveBeenCalledWith('a1');
      expect(client.getNote).not.toHaveBeenCalled();
    });

    it('requires exactly one of noteId/attributeId', async () => {
      await expect(handleAttributeTool(client, 'get_attributes', {})).rejects.toThrow();
      await expect(
        handleAttributeTool(client, 'get_attributes', { noteId: 'n1', attributeId: 'a1' })
      ).rejects.toThrow();
    });
  });

  describe('set_attribute', () => {
    it('upserts (updates existing)', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({
        noteId: 'n1',
        attributes: [{ attributeId: 'a1', type: 'label', name: 'foo', value: 'old' }],
      });
      (client.updateAttribute as ReturnType<typeof vi.fn>).mockResolvedValue({ attributeId: 'a1' });

      await handleAttributeTool(client, 'set_attribute', {
        noteId: 'n1',
        type: 'label',
        name: 'foo',
        value: 'new',
      });

      expect(client.updateAttribute).toHaveBeenCalledWith('a1', { value: 'new', position: undefined });
      expect(client.createAttribute).not.toHaveBeenCalled();
    });

    it('upserts (creates new)', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({
        noteId: 'n1',
        attributes: [],
      });
      (client.createAttribute as ReturnType<typeof vi.fn>).mockResolvedValue({ attributeId: 'aNew' });

      await handleAttributeTool(client, 'set_attribute', {
        noteId: 'n1',
        type: 'label',
        name: 'foo',
        value: 'bar',
      });

      expect(client.createAttribute).toHaveBeenCalled();
    });

    it('mode="add" always creates, allowing multiple same-name labels', async () => {
      (client.getNote as ReturnType<typeof vi.fn>).mockResolvedValue({
        noteId: 'n1',
        attributes: [{ attributeId: 'a1', type: 'label', name: 'tag', value: 'first' }],
      });
      (client.createAttribute as ReturnType<typeof vi.fn>).mockResolvedValue({ attributeId: 'a2' });

      await handleAttributeTool(client, 'set_attribute', {
        noteId: 'n1',
        type: 'label',
        name: 'tag',
        value: 'second',
        mode: 'add',
      });

      expect(client.updateAttribute).not.toHaveBeenCalled();
      expect(client.createAttribute).toHaveBeenCalledWith(
        expect.objectContaining({ noteId: 'n1', name: 'tag', value: 'second' })
      );
    });

    it('a forced attributeId bypasses the upsert lookup and creates directly', async () => {
      (client.createAttribute as ReturnType<typeof vi.fn>).mockResolvedValue({
        attributeId: 'forced123',
      });

      await handleAttributeTool(client, 'set_attribute', {
        noteId: 'n1',
        type: 'label',
        name: 'foo',
        value: 'bar',
        attributeId: 'forced123',
      });

      expect(client.getNote).not.toHaveBeenCalled();
      expect(client.createAttribute).toHaveBeenCalledWith(
        expect.objectContaining({ attributeId: 'forced123' })
      );
    });
  });

  describe('delete_attribute', () => {
    it('deletes the attribute', async () => {
      await handleAttributeTool(client, 'delete_attribute', { attributeId: 'a1' });
      expect(client.deleteAttribute).toHaveBeenCalledWith('a1');
    });
  });
});

// ============================================================================
// Calendar
// ============================================================================

describe('Calendar tools', () => {
  it('registers 1 tool (get_special_note)', () => {
    const tools = registerCalendarTools();
    expect(tools.map((t) => t.name)).toEqual(['get_special_note']);
  });

  let client: TriliumClient;
  beforeEach(() => {
    client = createMockClient();
  });

  it('kind="day" calls getDayNote', async () => {
    (client.getDayNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'day1' });
    await handleCalendarTool(client, 'get_special_note', { kind: 'day', date: '2026-04-22' });
    expect(client.getDayNote).toHaveBeenCalledWith('2026-04-22');
  });

  it('kind="inbox" calls getInboxNote', async () => {
    (client.getInboxNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'inbox1' });
    await handleCalendarTool(client, 'get_special_note', { kind: 'inbox', date: '2026-04-22' });
    expect(client.getInboxNote).toHaveBeenCalledWith('2026-04-22');
  });

  it('defaults date to today when omitted', async () => {
    (client.getDayNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'day1' });
    await handleCalendarTool(client, 'get_special_note', { kind: 'day' });
    const call = (client.getDayNote as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('kind="week" calls getWeekNote with an ISO week string', async () => {
    (client.getWeekNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'week1' });
    await handleCalendarTool(client, 'get_special_note', { kind: 'week', date: '2026-W03' });
    expect(client.getWeekNote).toHaveBeenCalledWith('2026-W03');
  });

  it('kind="month" calls getMonthNote', async () => {
    (client.getMonthNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'month1' });
    await handleCalendarTool(client, 'get_special_note', { kind: 'month', date: '2026-07' });
    expect(client.getMonthNote).toHaveBeenCalledWith('2026-07');
  });

  it('kind="year" calls getYearNote', async () => {
    (client.getYearNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'year1' });
    await handleCalendarTool(client, 'get_special_note', { kind: 'year', date: '2026' });
    expect(client.getYearNote).toHaveBeenCalledWith('2026');
  });

  it('defaults week/month/year to the current period when date omitted', async () => {
    (client.getWeekNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'w' });
    (client.getMonthNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'm' });
    (client.getYearNote as ReturnType<typeof vi.fn>).mockResolvedValue({ noteId: 'y' });
    await handleCalendarTool(client, 'get_special_note', { kind: 'week' });
    await handleCalendarTool(client, 'get_special_note', { kind: 'month' });
    await handleCalendarTool(client, 'get_special_note', { kind: 'year' });
    expect((client.getWeekNote as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /^\d{4}-W\d{2}$/
    );
    expect((client.getMonthNote as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /^\d{4}-\d{2}$/
    );
    expect((client.getYearNote as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/^\d{4}$/);
  });

  it('computes the ISO week-numbering year at year boundaries', () => {
    // 2024-12-30 (Monday) belongs to 2025-W01; 2021-01-01 (Friday) belongs to 2020-W53
    expect(isoWeekString(new Date(2024, 11, 30))).toBe('2025-W01');
    expect(isoWeekString(new Date(2021, 0, 1))).toBe('2020-W53');
  });

  it('rejects unknown kind', async () => {
    await expect(
      handleCalendarTool(client, 'get_special_note', { kind: 'decade' })
    ).rejects.toThrow();
  });

  it('rejects invalid date format', async () => {
    await expect(
      handleCalendarTool(client, 'get_special_note', { kind: 'day', date: '04/22/2026' })
    ).rejects.toThrow();
  });

  it('rejects a date whose format does not match the kind', async () => {
    await expect(
      handleCalendarTool(client, 'get_special_note', { kind: 'week', date: '2026-07-20' })
    ).rejects.toThrow();
    await expect(
      handleCalendarTool(client, 'get_special_note', { kind: 'day', date: '2026-W03' })
    ).rejects.toThrow();
  });

  it('rejects out-of-range ISO weeks', async () => {
    await expect(
      handleCalendarTool(client, 'get_special_note', { kind: 'week', date: '2026-W60' })
    ).rejects.toThrow();
  });
});

// ============================================================================
// System
// ============================================================================

describe('System tools', () => {
  it('registers 2 tools (create_revision, manage_system); search_tools is dropped', () => {
    const tools = registerSystemTools();
    expect(tools.map((t) => t.name)).toEqual(['create_revision', 'manage_system']);
    expect(tools.map((t) => t.name)).not.toContain('search_tools');
    expect(tools.map((t) => t.name)).not.toContain('create_backup');
    expect(tools.map((t) => t.name)).not.toContain('export_note');
  });

  let client: TriliumClient;
  beforeEach(() => {
    client = createMockClient();
  });

  describe('create_revision', () => {
    it('creates a revision with default format', async () => {
      await handleSystemTool(client, 'create_revision', { noteId: 'n1' });
      expect(client.createRevision).toHaveBeenCalledWith('n1', 'html');
    });

    it('accepts format="markdown"', async () => {
      await handleSystemTool(client, 'create_revision', { noteId: 'n1', format: 'markdown' });
      expect(client.createRevision).toHaveBeenCalledWith('n1', 'markdown');
    });

    it('appends the note url to the success message', async () => {
      (client.getNoteUrl as ReturnType<typeof vi.fn>).mockResolvedValue(
        'http://localhost:37740/#root/n1'
      );
      const result = await handleSystemTool(client, 'create_revision', { noteId: 'n1' });
      expect(client.getNoteUrl).toHaveBeenCalledWith('n1');
      expect((result?.content[0] as { text: string }).text).toContain(
        'http://localhost:37740/#root/n1'
      );
    });
  });

  describe('manage_system', () => {
    it('action="backup" creates backup', async () => {
      await handleSystemTool(client, 'manage_system', {
        action: 'backup',
        backupName: 'daily-01',
      });
      expect(client.createBackup).toHaveBeenCalledWith('daily-01');
    });

    it('action="backup" requires backupName', async () => {
      await expect(
        handleSystemTool(client, 'manage_system', { action: 'backup' })
      ).rejects.toThrow();
    });

    it('action="backup" rejects invalid backupName', async () => {
      await expect(
        handleSystemTool(client, 'manage_system', { action: 'backup', backupName: 'bad name!' })
      ).rejects.toThrow();
    });

    it('action="export" returns base64 ZIP', async () => {
      const data = new Uint8Array([80, 75]);
      (client.exportNote as ReturnType<typeof vi.fn>).mockResolvedValue(data.buffer);

      const result = await handleSystemTool(client, 'manage_system', {
        action: 'export',
        noteId: 'root',
        format: 'markdown',
      });
      expect(client.exportNote).toHaveBeenCalledWith('root', 'markdown');
      const parsed = JSON.parse((result?.content[0] as { text: string }).text);
      expect(parsed.base64Data).toBeTruthy();
    });

    it('action="export" requires noteId', async () => {
      await expect(
        handleSystemTool(client, 'manage_system', { action: 'export' })
      ).rejects.toThrow();
    });

    it('action="app_info" returns instance info', async () => {
      (client.getAppInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
        appVersion: '0.99.1',
        dbVersion: 231,
      });
      const result = await handleSystemTool(client, 'manage_system', { action: 'app_info' });
      expect(client.getAppInfo).toHaveBeenCalled();
      const parsed = JSON.parse((result?.content[0] as { text: string }).text);
      expect(parsed.appVersion).toBe('0.99.1');
    });

    it('action="import" decodes base64 and imports the ZIP under the parent note', async () => {
      const zipBytes = Buffer.from('PK-fake-zip');
      (client.importZip as ReturnType<typeof vi.fn>).mockResolvedValue({
        note: { noteId: 'imported1', title: 'Imported' },
        branch: { branchId: 'b1' },
      });
      const result = await handleSystemTool(client, 'manage_system', {
        action: 'import',
        noteId: 'parent1',
        data: zipBytes.toString('base64'),
      });
      expect(client.importZip).toHaveBeenCalledWith('parent1', expect.any(Buffer));
      const sent = (client.importZip as ReturnType<typeof vi.fn>).mock.calls[0][1] as Buffer;
      expect(sent.equals(zipBytes)).toBe(true);
      const parsed = JSON.parse((result?.content[0] as { text: string }).text);
      expect(parsed.note.noteId).toBe('imported1');
    });

    it('action="import" requires noteId and data', async () => {
      await expect(
        handleSystemTool(client, 'manage_system', { action: 'import' })
      ).rejects.toThrow();
      await expect(
        handleSystemTool(client, 'manage_system', { action: 'import', noteId: 'p1' })
      ).rejects.toThrow();
    });
  });
});

// ============================================================================
// Attachments
// ============================================================================

describe('Attachment tools', () => {
  it('registers 4 tools with reads first', () => {
    const tools = registerAttachmentTools();
    expect(tools.map((t) => t.name)).toEqual([
      'get_attachment',
      'create_attachment',
      'write_attachment',
      'delete_attachment',
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName['get_attachment'].annotations?.readOnlyHint).toBe(true);
    expect(byName['write_attachment'].annotations?.destructiveHint).toBe(true);
    expect(byName['delete_attachment'].annotations?.destructiveHint).toBe(true);
  });

  let client: TriliumClient;
  beforeEach(() => {
    client = createMockClient();
  });

  describe('create_attachment', () => {
    it('creates text attachment in one step', async () => {
      (client.createAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({ attachmentId: 'at1' });
      await handleAttachmentTool(client, 'create_attachment', {
        ownerId: 'n1',
        role: 'file',
        mime: 'text/plain',
        title: 'readme.txt',
        content: 'hello',
      });
      expect(client.createAttachment).toHaveBeenCalled();
      expect(client.updateAttachmentContentBinary).not.toHaveBeenCalled();
    });

    it('creates binary attachment in two steps', async () => {
      (client.createAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({ attachmentId: 'at1' });
      await handleAttachmentTool(client, 'create_attachment', {
        ownerId: 'n1',
        role: 'image',
        mime: 'image/png',
        title: 'x.png',
        content: Buffer.from('PNG').toString('base64'),
      });
      expect(client.updateAttachmentContentBinary).toHaveBeenCalled();
    });
  });

  describe('get_attachment', () => {
    it('returns list when given noteId', async () => {
      (client.getNoteAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([
        { attachmentId: 'a1' },
      ]);
      await handleAttachmentTool(client, 'get_attachment', { noteId: 'n1' });
      expect(client.getNoteAttachments).toHaveBeenCalledWith('n1');
    });

    it('returns content by default when given attachmentId', async () => {
      (client.getAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        attachmentId: 'a1',
        mime: 'text/plain',
      });
      (client.getAttachmentContent as ReturnType<typeof vi.fn>).mockResolvedValue('hello');
      const result = await handleAttachmentTool(client, 'get_attachment', { attachmentId: 'a1' });
      expect(client.getAttachmentContent).toHaveBeenCalledWith('a1');
      expect(result?.content[0]).toMatchObject({ type: 'text', text: 'hello' });
    });

    it('returns metadata only when include_content=false', async () => {
      (client.getAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        attachmentId: 'a1',
        mime: 'text/plain',
      });
      await handleAttachmentTool(client, 'get_attachment', {
        attachmentId: 'a1',
        include_content: false,
      });
      expect(client.getAttachmentContent).not.toHaveBeenCalled();
    });

    it('returns image block for image MIME when include_content=true', async () => {
      (client.getAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        attachmentId: 'a1',
        mime: 'image/png',
      });
      (client.getAttachmentContentAsBase64 as ReturnType<typeof vi.fn>).mockResolvedValue('Zm9v');
      const result = await handleAttachmentTool(client, 'get_attachment', {
        attachmentId: 'a1',
        include_content: true,
      });
      expect(result?.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    });

    it('returns text for text MIME when include_content=true', async () => {
      (client.getAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        attachmentId: 'a1',
        mime: 'text/plain',
      });
      (client.getAttachmentContent as ReturnType<typeof vi.fn>).mockResolvedValue('hello');
      const result = await handleAttachmentTool(client, 'get_attachment', {
        attachmentId: 'a1',
        include_content: true,
      });
      expect(result?.content[0]).toMatchObject({ type: 'text', text: 'hello' });
    });

    it('requires exactly one of attachmentId/noteId', async () => {
      await expect(handleAttachmentTool(client, 'get_attachment', {})).rejects.toThrow();
      await expect(
        handleAttachmentTool(client, 'get_attachment', { attachmentId: 'a1', noteId: 'n1' })
      ).rejects.toThrow();
    });

    it('create_attachment accepts a data URL and derives the MIME type from it', async () => {
      (client.createAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        attachmentId: 'a1',
      });
      await handleAttachmentTool(client, 'create_attachment', {
        ownerId: 'n1',
        role: 'image',
        mime: 'application/octet-stream',
        title: 'pic.png',
        content: `data:image/png;base64,${Buffer.from('ABC').toString('base64')}`,
      });
      expect(client.createAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ mime: 'image/png' })
      );
      const sent = (client.updateAttachmentContentBinary as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as Buffer;
      expect(sent.equals(Buffer.from('ABC'))).toBe(true);
    });

    it('write_attachment replace accepts a data URL for binary attachments', async () => {
      (client.getAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        attachmentId: 'a1',
        mime: 'image/png',
      });
      await handleAttachmentTool(client, 'write_attachment', {
        attachmentId: 'a1',
        mode: 'replace',
        content: `data:image/png;base64,${Buffer.from('XYZ').toString('base64')}`,
      });
      const sent = (client.updateAttachmentContentBinary as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as Buffer;
      expect(sent.equals(Buffer.from('XYZ'))).toBe(true);
    });

    it('caps oversized text attachment content with a steering notice', async () => {
      (client.getAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        attachmentId: 'a1',
        mime: 'text/plain',
      });
      (client.getAttachmentContent as ReturnType<typeof vi.fn>).mockResolvedValue('x'.repeat(60_000));
      const result = await handleAttachmentTool(client, 'get_attachment', {
        attachmentId: 'a1',
        include_content: true,
      });
      const text = (result?.content[0] as { text: string }).text;
      expect(text.length).toBeLessThan(51_000);
      expect(text).toContain('truncated');
    });
  });

  describe('write_attachment', () => {
    it('mode="metadata" updates attributes', async () => {
      (client.updateAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({ attachmentId: 'a1' });
      await handleAttachmentTool(client, 'write_attachment', {
        attachmentId: 'a1',
        mode: 'metadata',
        title: 'new.txt',
      });
      expect(client.updateAttachment).toHaveBeenCalledWith('a1', { title: 'new.txt' });
    });

    it('mode="metadata" requires at least one metadata field', async () => {
      await expect(
        handleAttachmentTool(client, 'write_attachment', { attachmentId: 'a1', mode: 'metadata' })
      ).rejects.toThrow();
    });

    it('mode="replace" writes text content for text MIME', async () => {
      (client.getAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        attachmentId: 'a1',
        mime: 'text/plain',
      });
      await handleAttachmentTool(client, 'write_attachment', {
        attachmentId: 'a1',
        mode: 'replace',
        content: 'new',
      });
      expect(client.updateAttachmentContent).toHaveBeenCalledWith('a1', 'new');
    });

    it('mode="replace" writes binary for binary MIME', async () => {
      (client.getAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        attachmentId: 'a1',
        mime: 'image/png',
      });
      await handleAttachmentTool(client, 'write_attachment', {
        attachmentId: 'a1',
        mode: 'replace',
        content: Buffer.from('PNG').toString('base64'),
      });
      expect(client.updateAttachmentContentBinary).toHaveBeenCalled();
    });

    it('mode="replace" requires content', async () => {
      await expect(
        handleAttachmentTool(client, 'write_attachment', { attachmentId: 'a1', mode: 'replace' })
      ).rejects.toThrow();
    });

    it('mode="edit" applies search/replace', async () => {
      let stored = 'foo bar';
      (client.getAttachmentContent as ReturnType<typeof vi.fn>).mockImplementation(async () => stored);
      (client.updateAttachmentContent as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, body: string) => {
          stored = body;
        }
      );

      await handleAttachmentTool(client, 'write_attachment', {
        attachmentId: 'a1',
        mode: 'edit',
        changes: [{ old_string: 'foo', new_string: 'baz' }],
      });

      expect(client.updateAttachmentContent).toHaveBeenCalledWith('a1', 'baz bar');
    });

    it('mode="edit" requires exactly one of changes/patch', async () => {
      await expect(
        handleAttachmentTool(client, 'write_attachment', { attachmentId: 'a1', mode: 'edit' })
      ).rejects.toThrow();
    });
  });

  describe('delete_attachment', () => {
    it('deletes by id', async () => {
      await handleAttachmentTool(client, 'delete_attachment', { attachmentId: 'a1' });
      expect(client.deleteAttachment).toHaveBeenCalledWith('a1');
    });
  });
});

// ============================================================================
// Revisions
// ============================================================================

describe('Revision tools', () => {
  it('registers 1 tool (get_revisions)', () => {
    const tools = registerRevisionTools();
    expect(tools.map((t) => t.name)).toEqual(['get_revisions']);
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
  });

  let client: TriliumClient;
  beforeEach(() => {
    client = createMockClient();
  });

  it('list mode (noteId) returns array', async () => {
    (client.getNoteRevisions as ReturnType<typeof vi.fn>).mockResolvedValue([{ revisionId: 'r1' }]);
    await handleRevisionTool(client, 'get_revisions', { noteId: 'n1' });
    expect(client.getNoteRevisions).toHaveBeenCalledWith('n1');
    expect(client.getRevision).not.toHaveBeenCalled();
    expect(client.getRevisionContent).not.toHaveBeenCalled();
  });

  it('content mode (revisionId, default) returns HTML body', async () => {
    (client.getRevisionContent as ReturnType<typeof vi.fn>).mockResolvedValue('<p>old</p>');
    const result = await handleRevisionTool(client, 'get_revisions', { revisionId: 'r1' });
    expect(client.getRevisionContent).toHaveBeenCalledWith('r1');
    expect(client.getRevision).not.toHaveBeenCalled();
    expect(result?.content[0]).toMatchObject({ type: 'text', text: '<p>old</p>' });
  });

  it('metadata mode (revisionId + include_content=false) returns single revision metadata', async () => {
    (client.getRevision as ReturnType<typeof vi.fn>).mockResolvedValue({ revisionId: 'r1' });
    await handleRevisionTool(client, 'get_revisions', {
      revisionId: 'r1',
      include_content: false,
    });
    expect(client.getRevision).toHaveBeenCalledWith('r1');
    expect(client.getRevisionContent).not.toHaveBeenCalled();
  });

  it('content mode (revisionId + explicit include_content=true) returns HTML', async () => {
    (client.getRevisionContent as ReturnType<typeof vi.fn>).mockResolvedValue('<p>old</p>');
    const result = await handleRevisionTool(client, 'get_revisions', {
      revisionId: 'r1',
      include_content: true,
    });
    expect(client.getRevisionContent).toHaveBeenCalledWith('r1');
    expect(result?.content[0]).toMatchObject({ type: 'text', text: '<p>old</p>' });
  });

  it('caps oversized revision content with a steering notice', async () => {
    (client.getRevisionContent as ReturnType<typeof vi.fn>).mockResolvedValue('x'.repeat(60_000));
    const result = await handleRevisionTool(client, 'get_revisions', { revisionId: 'r1' });
    const text = (result?.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(51_000);
    expect(text).toContain('truncated');
  });

  it('requires exactly one of noteId/revisionId', async () => {
    await expect(handleRevisionTool(client, 'get_revisions', {})).rejects.toThrow();
    await expect(
      handleRevisionTool(client, 'get_revisions', { noteId: 'n1', revisionId: 'r1' })
    ).rejects.toThrow();
  });
});

// ============================================================================
// Total tool surface
// ============================================================================

describe('Total tool surface', () => {
  it('exposes exactly 19 tools after consolidation (see issue #6)', () => {
    const allTools = [
      ...registerSearchTools(),
      ...registerNoteTools(),
      ...registerRevisionTools(),
      ...registerAttributeTools(),
      ...registerAttachmentTools(),
      ...registerCalendarTools(),
      ...registerOrganizationTools(),
      ...registerSystemTools(),
    ];
    expect(allTools).toHaveLength(19);

    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(19); // no duplicates

    // Dropped tools from pre-consolidation surface
    for (const dropped of [
      'get_note_content',
      'update_note',
      'update_note_content',
      'append_note_content',
      'undelete_note',
      'get_note_attachments',
      'get_attribute',
      'get_day_note',
      'get_inbox_note',
      'move_note',
      'clone_note',
      'reorder_notes',
      'delete_branch',
      'get_attachment_content',
      'update_attachment',
      'update_attachment_content',
      'get_note_revisions',
      'get_revision',
      'get_revision_content',
      'create_backup',
      'export_note',
      'search_tools',
    ]) {
      expect(names).not.toContain(dropped);
    }
  });

  it('every tool has title and at least one hint annotation', () => {
    const allTools = [
      ...registerSearchTools(),
      ...registerNoteTools(),
      ...registerRevisionTools(),
      ...registerAttributeTools(),
      ...registerAttachmentTools(),
      ...registerCalendarTools(),
      ...registerOrganizationTools(),
      ...registerSystemTools(),
    ];
    for (const t of allTools) {
      expect(t.annotations).toBeDefined();
      expect(t.annotations?.title).toBeTruthy();
      const hasHint =
        t.annotations?.readOnlyHint !== undefined ||
        t.annotations?.destructiveHint !== undefined ||
        t.annotations?.idempotentHint !== undefined;
      expect(hasHint).toBe(true);
    }
  });

  it('every inputSchema has type: "object" (required by MCP spec)', () => {
    const allTools = [
      ...registerSearchTools(),
      ...registerNoteTools(),
      ...registerRevisionTools(),
      ...registerAttributeTools(),
      ...registerAttachmentTools(),
      ...registerCalendarTools(),
      ...registerOrganizationTools(),
      ...registerSystemTools(),
    ];
    for (const t of allTools) {
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('fields with a schema default are never listed as required (input semantics)', () => {
    const allTools = [
      ...registerSearchTools(),
      ...registerNoteTools(),
      ...registerRevisionTools(),
      ...registerAttributeTools(),
      ...registerAttachmentTools(),
      ...registerCalendarTools(),
      ...registerOrganizationTools(),
      ...registerSystemTools(),
    ];
    for (const t of allTools) {
      const properties = t.inputSchema.properties as Record<string, { default?: unknown }>;
      const required = (t.inputSchema.required as string[] | undefined) ?? [];
      for (const [name, prop] of Object.entries(properties)) {
        if (prop.default !== undefined) {
          expect(required, `${t.name}.${name} has a default but is marked required`).not.toContain(
            name
          );
        }
      }
    }
  });

  it('include_content is optional with an advertised default of true', () => {
    const allTools = [
      ...registerNoteTools(),
      ...registerRevisionTools(),
      ...registerAttachmentTools(),
    ];
    for (const toolName of ['get_note', 'get_revisions', 'get_attachment']) {
      const tool = allTools.find((t) => t.name === toolName);
      expect(tool, toolName).toBeDefined();
      const props = tool!.inputSchema.properties as Record<string, { default?: unknown }>;
      expect(props.include_content.default, `${toolName}.include_content`).toBe(true);
      const required = (tool!.inputSchema.required as string[] | undefined) ?? [];
      expect(required, `${toolName}.include_content`).not.toContain('include_content');
    }
  });

  it('format and includeImages params advertise their defaults in the schema', () => {
    const allTools = [
      ...registerNoteTools(),
      ...registerSystemTools(),
    ];
    const expectations: Array<[string, string, unknown]> = [
      ['get_note', 'format', 'html'],
      ['get_note', 'includeImages', true],
      ['create_note', 'format', 'html'],
      ['write_note', 'format', 'html'],
      ['create_revision', 'format', 'html'],
      ['manage_system', 'format', 'html'],
    ];
    for (const [toolName, param, expected] of expectations) {
      const tool = allTools.find((t) => t.name === toolName);
      expect(tool, toolName).toBeDefined();
      const props = tool!.inputSchema.properties as Record<string, { default?: unknown }>;
      expect(props[param].default, `${toolName}.${param}`).toBe(expected);
    }
  });
});
