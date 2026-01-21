import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerNoteTools, handleNoteTool } from '../../src/tools/notes.js';
import { registerSearchTools, handleSearchTool } from '../../src/tools/search.js';
import { registerOrganizationTools, handleOrganizationTool } from '../../src/tools/organization.js';
import { registerAttributeTools, handleAttributeTool } from '../../src/tools/attributes.js';
import { registerCalendarTools, handleCalendarTool } from '../../src/tools/calendar.js';
import { registerSystemTools, handleSystemTool } from '../../src/tools/system.js';
import type { TriliumClient } from '../../src/client/trilium.js';

// Mock client factory
function createMockClient(overrides: Partial<TriliumClient> = {}): TriliumClient {
  return {
    createNote: vi.fn(),
    getNote: vi.fn(),
    getNoteContent: vi.fn(),
    updateNote: vi.fn(),
    updateNoteContent: vi.fn(),
    deleteNote: vi.fn(),
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
    createRevision: vi.fn(),
    createBackup: vi.fn(),
    exportNote: vi.fn(),
    ...overrides,
  } as unknown as TriliumClient;
}

describe('Note Tools', () => {
  describe('registerNoteTools', () => {
    it('should register 6 note tools', () => {
      const tools = registerNoteTools();
      expect(tools).toHaveLength(6);
      expect(tools.map((t) => t.name)).toEqual([
        'create_note',
        'get_note',
        'get_note_content',
        'update_note',
        'update_note_content',
        'delete_note',
      ]);
    });

    it('should have correct input schemas for all tools', () => {
      const tools = registerNoteTools();
      const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));

      // create_note schema
      expect(toolMap['create_note'].inputSchema.required).toEqual([
        'parentNoteId',
        'title',
        'type',
        'content',
      ]);
      expect(toolMap['create_note'].inputSchema.properties).toHaveProperty('mime');

      // update_note schema - noteId required, others optional
      expect(toolMap['update_note'].inputSchema.required).toEqual(['noteId']);
      expect(toolMap['update_note'].inputSchema.properties).toHaveProperty('title');
      expect(toolMap['update_note'].inputSchema.properties).toHaveProperty('type');
      expect(toolMap['update_note'].inputSchema.properties).toHaveProperty('mime');
    });
  });

  describe('handleNoteTool', () => {
    let mockClient: TriliumClient;

    beforeEach(() => {
      mockClient = createMockClient();
    });

    describe('create_note', () => {
      it('should create note with required parameters', async () => {
        const mockResult = {
          note: { noteId: 'new123', title: 'Test' },
          branch: { branchId: 'branch123' },
        };
        vi.mocked(mockClient.createNote).mockResolvedValue(mockResult as any);

        const result = await handleNoteTool(mockClient, 'create_note', {
          parentNoteId: 'root',
          title: 'Test',
          type: 'text',
          content: '<p>Hello</p>',
        });

        expect(result).not.toBeNull();
        expect(mockClient.createNote).toHaveBeenCalledWith({
          parentNoteId: 'root',
          title: 'Test',
          type: 'text',
          content: '<p>Hello</p>',
          mime: undefined,
          notePosition: undefined,
          prefix: undefined,
          isExpanded: undefined,
          noteId: undefined,
          branchId: undefined,
          dateCreated: undefined,
          utcDateCreated: undefined,
        });
      });

      it('should create note with notePosition', async () => {
        const mockResult = {
          note: { noteId: 'new123' },
          branch: { branchId: 'branch123', notePosition: 5 },
        };
        vi.mocked(mockClient.createNote).mockResolvedValue(mockResult as any);

        await handleNoteTool(mockClient, 'create_note', {
          parentNoteId: 'root',
          title: 'First Note',
          type: 'text',
          content: '<p>Content</p>',
          notePosition: 5,
        });

        expect(mockClient.createNote).toHaveBeenCalledWith(
          expect.objectContaining({ notePosition: 5 })
        );
      });

      it('should create note with prefix', async () => {
        const mockResult = {
          note: { noteId: 'new123' },
          branch: { branchId: 'branch123', prefix: 'Draft' },
        };
        vi.mocked(mockClient.createNote).mockResolvedValue(mockResult as any);

        await handleNoteTool(mockClient, 'create_note', {
          parentNoteId: 'root',
          title: 'My Note',
          type: 'text',
          content: '<p>Content</p>',
          prefix: 'Draft',
        });

        expect(mockClient.createNote).toHaveBeenCalledWith(
          expect.objectContaining({ prefix: 'Draft' })
        );
      });

      it('should create note with isExpanded', async () => {
        const mockResult = {
          note: { noteId: 'new123' },
          branch: { branchId: 'branch123', isExpanded: true },
        };
        vi.mocked(mockClient.createNote).mockResolvedValue(mockResult as any);

        await handleNoteTool(mockClient, 'create_note', {
          parentNoteId: 'root',
          title: 'Folder Note',
          type: 'text',
          content: '<p>Content</p>',
          isExpanded: true,
        });

        expect(mockClient.createNote).toHaveBeenCalledWith(
          expect.objectContaining({ isExpanded: true })
        );
      });

      it('should create note with dateCreated for backdating', async () => {
        const mockResult = {
          note: { noteId: 'new123', dateCreated: '2023-06-15 10:30:00.000+0100' },
          branch: { branchId: 'branch123' },
        };
        vi.mocked(mockClient.createNote).mockResolvedValue(mockResult as any);

        await handleNoteTool(mockClient, 'create_note', {
          parentNoteId: 'root',
          title: 'Backdated Note',
          type: 'text',
          content: '<p>From the past</p>',
          dateCreated: '2023-06-15 10:30:00.000+0100',
        });

        expect(mockClient.createNote).toHaveBeenCalledWith(
          expect.objectContaining({ dateCreated: '2023-06-15 10:30:00.000+0100' })
        );
      });

      it('should create note with forced noteId', async () => {
        const mockResult = {
          note: { noteId: 'customId123' },
          branch: { branchId: 'branch123' },
        };
        vi.mocked(mockClient.createNote).mockResolvedValue(mockResult as any);

        await handleNoteTool(mockClient, 'create_note', {
          parentNoteId: 'root',
          title: 'Custom ID Note',
          type: 'text',
          content: '<p>Content</p>',
          noteId: 'customId123',
        });

        expect(mockClient.createNote).toHaveBeenCalledWith(
          expect.objectContaining({ noteId: 'customId123' })
        );
      });

      it('should create note with all optional parameters', async () => {
        const mockResult = {
          note: { noteId: 'full123' },
          branch: { branchId: 'branch123' },
        };
        vi.mocked(mockClient.createNote).mockResolvedValue(mockResult as any);

        await handleNoteTool(mockClient, 'create_note', {
          parentNoteId: 'root',
          title: 'Full Note',
          type: 'code',
          content: 'print("hello")',
          mime: 'text/x-python',
          notePosition: 100,
          prefix: 'Archive',
          isExpanded: false,
          noteId: 'customNote',
          branchId: 'customBranch',
          dateCreated: '2023-01-01 00:00:00.000+0000',
          utcDateCreated: '2023-01-01 00:00:00.000Z',
        });

        expect(mockClient.createNote).toHaveBeenCalledWith({
          parentNoteId: 'root',
          title: 'Full Note',
          type: 'code',
          content: 'print("hello")',
          mime: 'text/x-python',
          notePosition: 100,
          prefix: 'Archive',
          isExpanded: false,
          noteId: 'customNote',
          branchId: 'customBranch',
          dateCreated: '2023-01-01 00:00:00.000+0000',
          utcDateCreated: '2023-01-01 00:00:00.000Z',
        });
      });

      it('should create note with mime type for code notes', async () => {
        const mockResult = {
          note: { noteId: 'code123', type: 'code' },
          branch: { branchId: 'branch123' },
        };
        vi.mocked(mockClient.createNote).mockResolvedValue(mockResult as any);

        await handleNoteTool(mockClient, 'create_note', {
          parentNoteId: 'root',
          title: 'Script',
          type: 'code',
          content: 'console.log("hello")',
          mime: 'application/javascript',
        });

        expect(mockClient.createNote).toHaveBeenCalledWith({
          parentNoteId: 'root',
          title: 'Script',
          type: 'code',
          content: 'console.log("hello")',
          mime: 'application/javascript',
        });
      });

      it('should create note with empty content', async () => {
        const mockResult = { note: { noteId: 'empty123' }, branch: { branchId: 'b1' } };
        vi.mocked(mockClient.createNote).mockResolvedValue(mockResult as any);

        await handleNoteTool(mockClient, 'create_note', {
          parentNoteId: 'root',
          title: 'Empty Note',
          type: 'text',
          content: '',
        });

        expect(mockClient.createNote).toHaveBeenCalledWith(
          expect.objectContaining({ content: '' })
        );
      });

      it('should handle special characters in title', async () => {
        const mockResult = { note: { noteId: 'special123' }, branch: { branchId: 'b1' } };
        vi.mocked(mockClient.createNote).mockResolvedValue(mockResult as any);

        const specialTitle = 'Test <script>alert("xss")</script> & "quotes"';
        await handleNoteTool(mockClient, 'create_note', {
          parentNoteId: 'root',
          title: specialTitle,
          type: 'text',
          content: '<p>Content</p>',
        });

        expect(mockClient.createNote).toHaveBeenCalledWith(
          expect.objectContaining({ title: specialTitle })
        );
      });

      it('should reject invalid note type', async () => {
        await expect(
          handleNoteTool(mockClient, 'create_note', {
            parentNoteId: 'root',
            title: 'Test',
            type: 'invalid_type',
            content: 'content',
          })
        ).rejects.toThrow();
      });
    });

    describe('get_note', () => {
      it('should get note by ID', async () => {
        const mockNote = {
          noteId: 'abc123',
          title: 'Test Note',
          type: 'text',
          attributes: [],
        };
        vi.mocked(mockClient.getNote).mockResolvedValue(mockNote as any);

        const result = await handleNoteTool(mockClient, 'get_note', { noteId: 'abc123' });

        expect(result).not.toBeNull();
        expect(mockClient.getNote).toHaveBeenCalledWith('abc123');
        expect(result!.content[0].text).toContain('abc123');
      });

      it('should reject missing noteId', async () => {
        await expect(handleNoteTool(mockClient, 'get_note', {})).rejects.toThrow();
      });
    });

    describe('get_note_content', () => {
      it('should get text note content', async () => {
        vi.mocked(mockClient.getNoteContent).mockResolvedValue('<p>Hello World</p>');

        const result = await handleNoteTool(mockClient, 'get_note_content', {
          noteId: 'note123',
        });

        expect(result).not.toBeNull();
        expect(mockClient.getNoteContent).toHaveBeenCalledWith('note123');
        expect(result!.content[0].text).toBe('<p>Hello World</p>');
      });

      it('should get code note content', async () => {
        const codeContent = 'function test() {\n  return 42;\n}';
        vi.mocked(mockClient.getNoteContent).mockResolvedValue(codeContent);

        const result = await handleNoteTool(mockClient, 'get_note_content', {
          noteId: 'code123',
        });

        expect(result!.content[0].text).toBe(codeContent);
      });

      it('should handle empty content', async () => {
        vi.mocked(mockClient.getNoteContent).mockResolvedValue('');

        const result = await handleNoteTool(mockClient, 'get_note_content', {
          noteId: 'empty123',
        });

        expect(result!.content[0].text).toBe('');
      });
    });

    describe('update_note', () => {
      it('should update note title only', async () => {
        const mockNote = { noteId: 'abc123', title: 'New Title' };
        vi.mocked(mockClient.updateNote).mockResolvedValue(mockNote as any);

        const result = await handleNoteTool(mockClient, 'update_note', {
          noteId: 'abc123',
          title: 'New Title',
        });

        expect(result).not.toBeNull();
        expect(mockClient.updateNote).toHaveBeenCalledWith('abc123', { title: 'New Title' });
      });

      it('should update note type', async () => {
        const mockNote = { noteId: 'abc123', type: 'code' };
        vi.mocked(mockClient.updateNote).mockResolvedValue(mockNote as any);

        await handleNoteTool(mockClient, 'update_note', {
          noteId: 'abc123',
          type: 'code',
        });

        expect(mockClient.updateNote).toHaveBeenCalledWith('abc123', { type: 'code' });
      });

      it('should update note mime type', async () => {
        const mockNote = { noteId: 'abc123', mime: 'text/markdown' };
        vi.mocked(mockClient.updateNote).mockResolvedValue(mockNote as any);

        await handleNoteTool(mockClient, 'update_note', {
          noteId: 'abc123',
          mime: 'text/markdown',
        });

        expect(mockClient.updateNote).toHaveBeenCalledWith('abc123', { mime: 'text/markdown' });
      });

      it('should update multiple properties at once', async () => {
        const mockNote = { noteId: 'abc123', title: 'New', type: 'code', mime: 'text/python' };
        vi.mocked(mockClient.updateNote).mockResolvedValue(mockNote as any);

        await handleNoteTool(mockClient, 'update_note', {
          noteId: 'abc123',
          title: 'New',
          type: 'code',
          mime: 'text/python',
        });

        expect(mockClient.updateNote).toHaveBeenCalledWith('abc123', {
          title: 'New',
          type: 'code',
          mime: 'text/python',
        });
      });

      it('should reject invalid type value', async () => {
        await expect(
          handleNoteTool(mockClient, 'update_note', {
            noteId: 'abc123',
            type: 'invalid',
          })
        ).rejects.toThrow();
      });
    });

    describe('update_note_content', () => {
      it('should update note content', async () => {
        vi.mocked(mockClient.updateNoteContent).mockResolvedValue(undefined);

        const result = await handleNoteTool(mockClient, 'update_note_content', {
          noteId: 'abc123',
          content: '<p>Updated content</p>',
        });

        expect(result).not.toBeNull();
        expect(mockClient.updateNoteContent).toHaveBeenCalledWith(
          'abc123',
          '<p>Updated content</p>'
        );
        expect(result!.content[0].text).toContain('updated successfully');
      });

      it('should update with empty content', async () => {
        vi.mocked(mockClient.updateNoteContent).mockResolvedValue(undefined);

        await handleNoteTool(mockClient, 'update_note_content', {
          noteId: 'abc123',
          content: '',
        });

        expect(mockClient.updateNoteContent).toHaveBeenCalledWith('abc123', '');
      });

      it('should handle large content', async () => {
        vi.mocked(mockClient.updateNoteContent).mockResolvedValue(undefined);
        const largeContent = '<p>' + 'x'.repeat(100000) + '</p>';

        await handleNoteTool(mockClient, 'update_note_content', {
          noteId: 'abc123',
          content: largeContent,
        });

        expect(mockClient.updateNoteContent).toHaveBeenCalledWith('abc123', largeContent);
      });
    });

    describe('delete_note', () => {
      it('should delete note by ID', async () => {
        vi.mocked(mockClient.deleteNote).mockResolvedValue(undefined);

        const result = await handleNoteTool(mockClient, 'delete_note', { noteId: 'abc123' });

        expect(result).not.toBeNull();
        expect(mockClient.deleteNote).toHaveBeenCalledWith('abc123');
        expect(result!.content[0].text).toContain('deleted successfully');
      });

      it('should reject missing noteId', async () => {
        await expect(handleNoteTool(mockClient, 'delete_note', {})).rejects.toThrow();
      });
    });

    it('should return null for unknown tool', async () => {
      const result = await handleNoteTool(mockClient, 'unknown_tool', {});
      expect(result).toBeNull();
    });
  });
});

describe('Search Tools', () => {
  describe('registerSearchTools', () => {
    it('should register 2 search tools', () => {
      const tools = registerSearchTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(['search_notes', 'get_note_tree']);
    });

    it('should have correct input schema for search_notes', () => {
      const tools = registerSearchTools();
      const searchTool = tools.find((t) => t.name === 'search_notes')!;

      expect(searchTool.inputSchema.required).toEqual(['query']);
      expect(searchTool.inputSchema.properties).toHaveProperty('fastSearch');
      expect(searchTool.inputSchema.properties).toHaveProperty('includeArchivedNotes');
      expect(searchTool.inputSchema.properties).toHaveProperty('ancestorNoteId');
      expect(searchTool.inputSchema.properties).toHaveProperty('orderBy');
      expect(searchTool.inputSchema.properties).toHaveProperty('orderDirection');
      expect(searchTool.inputSchema.properties).toHaveProperty('limit');
    });
  });

  describe('handleSearchTool', () => {
    let mockClient: TriliumClient;

    beforeEach(() => {
      mockClient = createMockClient();
    });

    describe('search_notes', () => {
      it('should search with query only', async () => {
        vi.mocked(mockClient.searchNotes).mockResolvedValue({ results: [] });

        await handleSearchTool(mockClient, 'search_notes', { query: 'test' });

        expect(mockClient.searchNotes).toHaveBeenCalledWith({
          search: 'test',
          fastSearch: undefined,
          includeArchivedNotes: undefined,
          ancestorNoteId: undefined,
          orderBy: undefined,
          orderDirection: undefined,
          limit: undefined,
        });
      });

      it('should search with fastSearch enabled', async () => {
        vi.mocked(mockClient.searchNotes).mockResolvedValue({ results: [] });

        await handleSearchTool(mockClient, 'search_notes', {
          query: 'test',
          fastSearch: true,
        });

        expect(mockClient.searchNotes).toHaveBeenCalledWith(
          expect.objectContaining({ fastSearch: true })
        );
      });

      it('should search including archived notes', async () => {
        vi.mocked(mockClient.searchNotes).mockResolvedValue({ results: [] });

        await handleSearchTool(mockClient, 'search_notes', {
          query: 'test',
          includeArchivedNotes: true,
        });

        expect(mockClient.searchNotes).toHaveBeenCalledWith(
          expect.objectContaining({ includeArchivedNotes: true })
        );
      });

      it('should search within ancestor subtree', async () => {
        vi.mocked(mockClient.searchNotes).mockResolvedValue({ results: [] });

        await handleSearchTool(mockClient, 'search_notes', {
          query: 'test',
          ancestorNoteId: 'parent123',
        });

        expect(mockClient.searchNotes).toHaveBeenCalledWith(
          expect.objectContaining({ ancestorNoteId: 'parent123' })
        );
      });

      it('should search with ordering by title ascending', async () => {
        vi.mocked(mockClient.searchNotes).mockResolvedValue({ results: [] });

        await handleSearchTool(mockClient, 'search_notes', {
          query: 'test',
          orderBy: 'title',
          orderDirection: 'asc',
        });

        expect(mockClient.searchNotes).toHaveBeenCalledWith(
          expect.objectContaining({ orderBy: 'title', orderDirection: 'asc' })
        );
      });

      it('should search with ordering by dateModified descending', async () => {
        vi.mocked(mockClient.searchNotes).mockResolvedValue({ results: [] });

        await handleSearchTool(mockClient, 'search_notes', {
          query: 'test',
          orderBy: 'dateModified',
          orderDirection: 'desc',
        });

        expect(mockClient.searchNotes).toHaveBeenCalledWith(
          expect.objectContaining({ orderBy: 'dateModified', orderDirection: 'desc' })
        );
      });

      it('should search with limit', async () => {
        vi.mocked(mockClient.searchNotes).mockResolvedValue({ results: [] });

        await handleSearchTool(mockClient, 'search_notes', {
          query: 'test',
          limit: 5,
        });

        expect(mockClient.searchNotes).toHaveBeenCalledWith(
          expect.objectContaining({ limit: 5 })
        );
      });

      it('should search with all parameters combined', async () => {
        vi.mocked(mockClient.searchNotes).mockResolvedValue({ results: [] });

        await handleSearchTool(mockClient, 'search_notes', {
          query: '#project',
          fastSearch: true,
          includeArchivedNotes: true,
          ancestorNoteId: 'workspace123',
          orderBy: 'dateCreated',
          orderDirection: 'desc',
          limit: 20,
        });

        expect(mockClient.searchNotes).toHaveBeenCalledWith({
          search: '#project',
          fastSearch: true,
          includeArchivedNotes: true,
          ancestorNoteId: 'workspace123',
          orderBy: 'dateCreated',
          orderDirection: 'desc',
          limit: 20,
        });
      });

      it('should return formatted results', async () => {
        const mockResults = {
          results: [
            { noteId: 'note1', title: 'First' },
            { noteId: 'note2', title: 'Second' },
          ],
        };
        vi.mocked(mockClient.searchNotes).mockResolvedValue(mockResults as any);

        const result = await handleSearchTool(mockClient, 'search_notes', { query: 'test' });

        const parsed = JSON.parse(result!.content[0].text);
        expect(parsed.results).toHaveLength(2);
      });

      it('should handle empty results', async () => {
        vi.mocked(mockClient.searchNotes).mockResolvedValue({ results: [] });

        const result = await handleSearchTool(mockClient, 'search_notes', { query: 'nonexistent' });

        const parsed = JSON.parse(result!.content[0].text);
        expect(parsed.results).toHaveLength(0);
      });

      it('should handle Trilium search syntax with labels', async () => {
        vi.mocked(mockClient.searchNotes).mockResolvedValue({ results: [] });

        await handleSearchTool(mockClient, 'search_notes', {
          query: '#priority=high #status=active',
        });

        expect(mockClient.searchNotes).toHaveBeenCalledWith(
          expect.objectContaining({ search: '#priority=high #status=active' })
        );
      });

      it('should reject invalid orderDirection', async () => {
        await expect(
          handleSearchTool(mockClient, 'search_notes', {
            query: 'test',
            orderDirection: 'invalid',
          })
        ).rejects.toThrow();
      });
    });

    describe('get_note_tree', () => {
      it('should get note tree for root', async () => {
        const mockNote = {
          noteId: 'root',
          title: 'Root',
          type: 'text',
          childNoteIds: ['child1', 'child2'],
          childBranchIds: ['branch1', 'branch2'],
        };
        vi.mocked(mockClient.getNote).mockResolvedValue(mockNote as any);

        const result = await handleSearchTool(mockClient, 'get_note_tree', { noteId: 'root' });

        expect(result).not.toBeNull();
        const parsed = JSON.parse(result!.content[0].text);
        expect(parsed.noteId).toBe('root');
        expect(parsed.childNoteIds).toEqual(['child1', 'child2']);
        expect(parsed.isExpanded).toBe(true);
      });

      it('should handle note with no children', async () => {
        const mockNote = {
          noteId: 'leaf',
          title: 'Leaf Note',
          type: 'text',
          childNoteIds: [],
          childBranchIds: [],
        };
        vi.mocked(mockClient.getNote).mockResolvedValue(mockNote as any);

        const result = await handleSearchTool(mockClient, 'get_note_tree', { noteId: 'leaf' });

        const parsed = JSON.parse(result!.content[0].text);
        expect(parsed.childNoteIds).toEqual([]);
        expect(parsed.isExpanded).toBe(false);
      });
    });

    it('should return null for unknown tool', async () => {
      const result = await handleSearchTool(mockClient, 'unknown_tool', {});
      expect(result).toBeNull();
    });
  });
});

describe('Organization Tools', () => {
  describe('registerOrganizationTools', () => {
    it('should register 3 organization tools', () => {
      const tools = registerOrganizationTools();
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name)).toEqual(['move_note', 'clone_note', 'reorder_notes']);
    });

    it('should have correct input schemas', () => {
      const tools = registerOrganizationTools();
      const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));

      expect(toolMap['move_note'].inputSchema.required).toEqual(['noteId', 'newParentNoteId']);
      expect(toolMap['move_note'].inputSchema.properties).toHaveProperty('prefix');

      expect(toolMap['clone_note'].inputSchema.required).toEqual(['noteId', 'parentNoteId']);
      expect(toolMap['clone_note'].inputSchema.properties).toHaveProperty('prefix');

      expect(toolMap['reorder_notes'].inputSchema.required).toEqual([
        'parentNoteId',
        'notePositions',
      ]);
    });
  });

  describe('handleOrganizationTool', () => {
    let mockClient: TriliumClient;

    beforeEach(() => {
      mockClient = createMockClient();
    });

    describe('move_note', () => {
      it('should move note to new parent', async () => {
        const mockNote = { noteId: 'note123', parentBranchIds: ['oldbranch'] };
        const mockNewBranch = { branchId: 'newbranch', noteId: 'note123', parentNoteId: 'newparent' };
        vi.mocked(mockClient.getNote).mockResolvedValue(mockNote as any);
        vi.mocked(mockClient.createBranch).mockResolvedValue(mockNewBranch as any);
        vi.mocked(mockClient.deleteBranch).mockResolvedValue(undefined);

        const result = await handleOrganizationTool(mockClient, 'move_note', {
          noteId: 'note123',
          newParentNoteId: 'newparent',
        });

        expect(result).not.toBeNull();
        expect(mockClient.getNote).toHaveBeenCalledWith('note123');
        expect(mockClient.createBranch).toHaveBeenCalledWith({
          noteId: 'note123',
          parentNoteId: 'newparent',
          prefix: undefined,
        });
        expect(mockClient.deleteBranch).toHaveBeenCalledWith('oldbranch');
      });

      it('should move note with prefix', async () => {
        const mockNote = { noteId: 'note123', parentBranchIds: ['oldbranch'] };
        const mockNewBranch = { branchId: 'newbranch', prefix: 'Archive' };
        vi.mocked(mockClient.getNote).mockResolvedValue(mockNote as any);
        vi.mocked(mockClient.createBranch).mockResolvedValue(mockNewBranch as any);
        vi.mocked(mockClient.deleteBranch).mockResolvedValue(undefined);

        await handleOrganizationTool(mockClient, 'move_note', {
          noteId: 'note123',
          newParentNoteId: 'archive',
          prefix: 'Archive',
        });

        expect(mockClient.createBranch).toHaveBeenCalledWith({
          noteId: 'note123',
          parentNoteId: 'archive',
          prefix: 'Archive',
        });
      });

      it('should handle note with no existing branches', async () => {
        const mockNote = { noteId: 'note123', parentBranchIds: [] };
        const mockNewBranch = { branchId: 'newbranch' };
        vi.mocked(mockClient.getNote).mockResolvedValue(mockNote as any);
        vi.mocked(mockClient.createBranch).mockResolvedValue(mockNewBranch as any);

        await handleOrganizationTool(mockClient, 'move_note', {
          noteId: 'note123',
          newParentNoteId: 'newparent',
        });

        expect(mockClient.deleteBranch).not.toHaveBeenCalled();
      });
    });

    describe('clone_note', () => {
      it('should clone note to new parent', async () => {
        const mockBranch = { branchId: 'newbranch', noteId: 'note123', parentNoteId: 'parent123' };
        vi.mocked(mockClient.createBranch).mockResolvedValue(mockBranch as any);

        const result = await handleOrganizationTool(mockClient, 'clone_note', {
          noteId: 'note123',
          parentNoteId: 'parent123',
        });

        expect(result).not.toBeNull();
        expect(mockClient.createBranch).toHaveBeenCalledWith({
          noteId: 'note123',
          parentNoteId: 'parent123',
          prefix: undefined,
        });
      });

      it('should clone note with prefix', async () => {
        const mockBranch = { branchId: 'newbranch', prefix: 'Reference' };
        vi.mocked(mockClient.createBranch).mockResolvedValue(mockBranch as any);

        await handleOrganizationTool(mockClient, 'clone_note', {
          noteId: 'note123',
          parentNoteId: 'refs',
          prefix: 'Reference',
        });

        expect(mockClient.createBranch).toHaveBeenCalledWith({
          noteId: 'note123',
          parentNoteId: 'refs',
          prefix: 'Reference',
        });
      });
    });

    describe('reorder_notes', () => {
      it('should reorder notes', async () => {
        const mockBranch1 = { branchId: 'b1', notePosition: 100 };
        const mockBranch2 = { branchId: 'b2', notePosition: 200 };
        vi.mocked(mockClient.updateBranch)
          .mockResolvedValueOnce(mockBranch1 as any)
          .mockResolvedValueOnce(mockBranch2 as any);
        vi.mocked(mockClient.refreshNoteOrdering).mockResolvedValue(undefined);

        const result = await handleOrganizationTool(mockClient, 'reorder_notes', {
          parentNoteId: 'parent123',
          notePositions: [
            { branchId: 'b1', notePosition: 100 },
            { branchId: 'b2', notePosition: 200 },
          ],
        });

        expect(result).not.toBeNull();
        expect(mockClient.updateBranch).toHaveBeenCalledWith('b1', { notePosition: 100 });
        expect(mockClient.updateBranch).toHaveBeenCalledWith('b2', { notePosition: 200 });
        expect(mockClient.refreshNoteOrdering).toHaveBeenCalledWith('parent123');
      });

      it('should handle empty notePositions array', async () => {
        vi.mocked(mockClient.refreshNoteOrdering).mockResolvedValue(undefined);

        const result = await handleOrganizationTool(mockClient, 'reorder_notes', {
          parentNoteId: 'parent123',
          notePositions: [],
        });

        expect(result).not.toBeNull();
        expect(mockClient.updateBranch).not.toHaveBeenCalled();
        expect(mockClient.refreshNoteOrdering).toHaveBeenCalledWith('parent123');
      });

      it('should handle single note reposition', async () => {
        const mockBranch = { branchId: 'b1', notePosition: 50 };
        vi.mocked(mockClient.updateBranch).mockResolvedValue(mockBranch as any);
        vi.mocked(mockClient.refreshNoteOrdering).mockResolvedValue(undefined);

        await handleOrganizationTool(mockClient, 'reorder_notes', {
          parentNoteId: 'parent123',
          notePositions: [{ branchId: 'b1', notePosition: 50 }],
        });

        expect(mockClient.updateBranch).toHaveBeenCalledTimes(1);
      });
    });

    it('should return null for unknown tool', async () => {
      const result = await handleOrganizationTool(mockClient, 'unknown_tool', {});
      expect(result).toBeNull();
    });
  });
});

describe('Attribute Tools', () => {
  describe('registerAttributeTools', () => {
    it('should register 3 attribute tools', () => {
      const tools = registerAttributeTools();
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name)).toEqual(['get_attributes', 'set_attribute', 'delete_attribute']);
    });

    it('should have correct input schema for set_attribute', () => {
      const tools = registerAttributeTools();
      const setAttrTool = tools.find((t) => t.name === 'set_attribute')!;

      expect(setAttrTool.inputSchema.required).toEqual(['noteId', 'type', 'name', 'value']);
      expect(setAttrTool.inputSchema.properties).toHaveProperty('isInheritable');
    });
  });

  describe('handleAttributeTool', () => {
    let mockClient: TriliumClient;

    beforeEach(() => {
      mockClient = createMockClient();
    });

    describe('get_attributes', () => {
      it('should get and categorize attributes', async () => {
        const mockNote = {
          noteId: 'abc123',
          attributes: [
            { attributeId: 'attr1', type: 'label', name: 'tag', value: 'test' },
            { attributeId: 'attr2', type: 'relation', name: 'parent', value: 'root' },
            { attributeId: 'attr3', type: 'label', name: 'priority', value: 'high' },
          ],
        };
        vi.mocked(mockClient.getNote).mockResolvedValue(mockNote as any);

        const result = await handleAttributeTool(mockClient, 'get_attributes', {
          noteId: 'abc123',
        });

        expect(result).not.toBeNull();
        const parsed = JSON.parse(result!.content[0].text);
        expect(parsed.labels).toHaveLength(2);
        expect(parsed.relations).toHaveLength(1);
      });

      it('should handle note with no attributes', async () => {
        vi.mocked(mockClient.getNote).mockResolvedValue({ noteId: 'abc', attributes: [] } as any);

        const result = await handleAttributeTool(mockClient, 'get_attributes', {
          noteId: 'abc',
        });

        const parsed = JSON.parse(result!.content[0].text);
        expect(parsed.labels).toHaveLength(0);
        expect(parsed.relations).toHaveLength(0);
      });
    });

    describe('set_attribute', () => {
      it('should create new label attribute', async () => {
        vi.mocked(mockClient.getNote).mockResolvedValue({ attributes: [] } as any);
        vi.mocked(mockClient.createAttribute).mockResolvedValue({
          attributeId: 'new',
          type: 'label',
          name: 'priority',
          value: 'high',
        } as any);

        const result = await handleAttributeTool(mockClient, 'set_attribute', {
          noteId: 'abc123',
          type: 'label',
          name: 'priority',
          value: 'high',
        });

        expect(result).not.toBeNull();
        expect(mockClient.createAttribute).toHaveBeenCalledWith({
          noteId: 'abc123',
          type: 'label',
          name: 'priority',
          value: 'high',
          isInheritable: undefined,
        });
        expect(mockClient.updateAttribute).not.toHaveBeenCalled();
      });

      it('should create new relation attribute', async () => {
        vi.mocked(mockClient.getNote).mockResolvedValue({ attributes: [] } as any);
        vi.mocked(mockClient.createAttribute).mockResolvedValue({
          attributeId: 'new',
          type: 'relation',
        } as any);

        await handleAttributeTool(mockClient, 'set_attribute', {
          noteId: 'abc123',
          type: 'relation',
          name: 'template',
          value: 'template123',
        });

        expect(mockClient.createAttribute).toHaveBeenCalledWith({
          noteId: 'abc123',
          type: 'relation',
          name: 'template',
          value: 'template123',
          isInheritable: undefined,
        });
      });

      it('should create inheritable attribute', async () => {
        vi.mocked(mockClient.getNote).mockResolvedValue({ attributes: [] } as any);
        vi.mocked(mockClient.createAttribute).mockResolvedValue({ attributeId: 'new' } as any);

        await handleAttributeTool(mockClient, 'set_attribute', {
          noteId: 'abc123',
          type: 'label',
          name: 'cssClass',
          value: 'highlight',
          isInheritable: true,
        });

        expect(mockClient.createAttribute).toHaveBeenCalledWith({
          noteId: 'abc123',
          type: 'label',
          name: 'cssClass',
          value: 'highlight',
          isInheritable: true,
        });
      });

      it('should update existing attribute by name and type match', async () => {
        vi.mocked(mockClient.getNote).mockResolvedValue({
          attributes: [
            { attributeId: 'existing', type: 'label', name: 'priority', value: 'low' },
          ],
        } as any);
        vi.mocked(mockClient.updateAttribute).mockResolvedValue({
          attributeId: 'existing',
          value: 'high',
        } as any);

        await handleAttributeTool(mockClient, 'set_attribute', {
          noteId: 'abc123',
          type: 'label',
          name: 'priority',
          value: 'high',
        });

        expect(mockClient.updateAttribute).toHaveBeenCalledWith('existing', { value: 'high' });
        expect(mockClient.createAttribute).not.toHaveBeenCalled();
      });

      it('should create new when same name but different type', async () => {
        vi.mocked(mockClient.getNote).mockResolvedValue({
          attributes: [
            { attributeId: 'existing', type: 'label', name: 'parent', value: 'somevalue' },
          ],
        } as any);
        vi.mocked(mockClient.createAttribute).mockResolvedValue({ attributeId: 'new' } as any);

        await handleAttributeTool(mockClient, 'set_attribute', {
          noteId: 'abc123',
          type: 'relation',
          name: 'parent',
          value: 'parentnote123',
        });

        expect(mockClient.createAttribute).toHaveBeenCalled();
        expect(mockClient.updateAttribute).not.toHaveBeenCalled();
      });

      it('should reject invalid attribute type', async () => {
        await expect(
          handleAttributeTool(mockClient, 'set_attribute', {
            noteId: 'abc123',
            type: 'invalid',
            name: 'test',
            value: 'value',
          })
        ).rejects.toThrow();
      });
    });

    describe('delete_attribute', () => {
      it('should delete attribute by ID', async () => {
        vi.mocked(mockClient.deleteAttribute).mockResolvedValue(undefined);

        const result = await handleAttributeTool(mockClient, 'delete_attribute', {
          attributeId: 'attr123',
        });

        expect(result).not.toBeNull();
        expect(mockClient.deleteAttribute).toHaveBeenCalledWith('attr123');
        expect(result!.content[0].text).toContain('deleted successfully');
      });

      it('should reject missing attributeId', async () => {
        await expect(
          handleAttributeTool(mockClient, 'delete_attribute', {})
        ).rejects.toThrow();
      });
    });

    it('should return null for unknown tool', async () => {
      const result = await handleAttributeTool(mockClient, 'unknown_tool', {});
      expect(result).toBeNull();
    });
  });
});

describe('Calendar Tools', () => {
  describe('registerCalendarTools', () => {
    it('should register 2 calendar tools', () => {
      const tools = registerCalendarTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(['get_day_note', 'get_inbox_note']);
    });

    it('should not require date parameter', () => {
      const tools = registerCalendarTools();
      tools.forEach((tool) => {
        expect(tool.inputSchema.required).toEqual([]);
      });
    });
  });

  describe('handleCalendarTool', () => {
    let mockClient: TriliumClient;

    beforeEach(() => {
      mockClient = createMockClient();
    });

    describe('get_day_note', () => {
      it('should get day note for specific date', async () => {
        vi.mocked(mockClient.getDayNote).mockResolvedValue({
          noteId: 'day123',
          title: '2024-01-15',
        } as any);

        const result = await handleCalendarTool(mockClient, 'get_day_note', {
          date: '2024-01-15',
        });

        expect(result).not.toBeNull();
        expect(mockClient.getDayNote).toHaveBeenCalledWith('2024-01-15');
      });

      it('should use today when date not provided', async () => {
        vi.mocked(mockClient.getDayNote).mockResolvedValue({ noteId: 'day123' } as any);

        await handleCalendarTool(mockClient, 'get_day_note', {});

        expect(mockClient.getDayNote).toHaveBeenCalled();
        const callArg = vi.mocked(mockClient.getDayNote).mock.calls[0][0];
        expect(callArg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      it('should return note details in response', async () => {
        const mockNote = {
          noteId: 'day123',
          title: '2024-01-15',
          type: 'text',
          dateCreated: '2024-01-15 00:00:00',
        };
        vi.mocked(mockClient.getDayNote).mockResolvedValue(mockNote as any);

        const result = await handleCalendarTool(mockClient, 'get_day_note', {
          date: '2024-01-15',
        });

        const parsed = JSON.parse(result!.content[0].text);
        expect(parsed.noteId).toBe('day123');
        expect(parsed.title).toBe('2024-01-15');
      });
    });

    describe('get_inbox_note', () => {
      it('should get inbox note for specific date', async () => {
        vi.mocked(mockClient.getInboxNote).mockResolvedValue({
          noteId: 'inbox123',
          title: 'Inbox',
        } as any);

        const result = await handleCalendarTool(mockClient, 'get_inbox_note', {
          date: '2024-01-15',
        });

        expect(result).not.toBeNull();
        expect(mockClient.getInboxNote).toHaveBeenCalledWith('2024-01-15');
      });

      it('should use today when date not provided', async () => {
        vi.mocked(mockClient.getInboxNote).mockResolvedValue({ noteId: 'inbox123' } as any);

        await handleCalendarTool(mockClient, 'get_inbox_note', {});

        expect(mockClient.getInboxNote).toHaveBeenCalled();
        const callArg = vi.mocked(mockClient.getInboxNote).mock.calls[0][0];
        expect(callArg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      it('should return inbox note details', async () => {
        const mockNote = { noteId: 'inbox123', title: 'Inbox', type: 'text' };
        vi.mocked(mockClient.getInboxNote).mockResolvedValue(mockNote as any);

        const result = await handleCalendarTool(mockClient, 'get_inbox_note', {
          date: '2024-01-15',
        });

        const parsed = JSON.parse(result!.content[0].text);
        expect(parsed.noteId).toBe('inbox123');
      });
    });

    it('should return null for unknown tool', async () => {
      const result = await handleCalendarTool(mockClient, 'unknown_tool', {});
      expect(result).toBeNull();
    });
  });
});

describe('System Tools', () => {
  describe('registerSystemTools', () => {
    it('should register 3 system tools', () => {
      const tools = registerSystemTools();
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name)).toEqual(['create_revision', 'create_backup', 'export_note']);
    });

    it('should have correct input schemas', () => {
      const tools = registerSystemTools();
      const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));

      expect(toolMap['create_revision'].inputSchema.required).toEqual(['noteId']);
      expect(toolMap['create_backup'].inputSchema.required).toEqual(['backupName']);
      expect(toolMap['export_note'].inputSchema.required).toEqual(['noteId']);
    });
  });

  describe('handleSystemTool', () => {
    let mockClient: TriliumClient;

    beforeEach(() => {
      mockClient = createMockClient();
    });

    describe('create_revision', () => {
      it('should create revision with default format', async () => {
        vi.mocked(mockClient.createRevision).mockResolvedValue(undefined);

        const result = await handleSystemTool(mockClient, 'create_revision', {
          noteId: 'abc123',
        });

        expect(result).not.toBeNull();
        expect(mockClient.createRevision).toHaveBeenCalledWith('abc123', 'html');
        expect(result!.content[0].text).toContain('Revision created');
      });

      it('should create revision with markdown format', async () => {
        vi.mocked(mockClient.createRevision).mockResolvedValue(undefined);

        await handleSystemTool(mockClient, 'create_revision', {
          noteId: 'abc123',
          format: 'markdown',
        });

        expect(mockClient.createRevision).toHaveBeenCalledWith('abc123', 'markdown');
      });

      it('should reject invalid format', async () => {
        await expect(
          handleSystemTool(mockClient, 'create_revision', {
            noteId: 'abc123',
            format: 'invalid',
          })
        ).rejects.toThrow();
      });
    });

    describe('create_backup', () => {
      it('should create backup with given name', async () => {
        vi.mocked(mockClient.createBackup).mockResolvedValue(undefined);

        const result = await handleSystemTool(mockClient, 'create_backup', {
          backupName: 'before-migration',
        });

        expect(result).not.toBeNull();
        expect(mockClient.createBackup).toHaveBeenCalledWith('before-migration');
        expect(result!.content[0].text).toContain('Backup created');
        expect(result!.content[0].text).toContain('backup-before-migration.db');
      });

      it('should reject missing backupName', async () => {
        await expect(handleSystemTool(mockClient, 'create_backup', {})).rejects.toThrow();
      });
    });

    describe('export_note', () => {
      it('should export note with default format', async () => {
        const mockData = new Uint8Array([80, 75, 3, 4]).buffer; // ZIP magic bytes
        vi.mocked(mockClient.exportNote).mockResolvedValue(mockData);

        const result = await handleSystemTool(mockClient, 'export_note', {
          noteId: 'abc123',
        });

        expect(result).not.toBeNull();
        expect(mockClient.exportNote).toHaveBeenCalledWith('abc123', 'html');
        const parsed = JSON.parse(result!.content[0].text);
        expect(parsed.noteId).toBe('abc123');
        expect(parsed.format).toBe('html');
        expect(parsed.sizeBytes).toBe(4);
        expect(parsed.base64Data).toBeDefined();
      });

      it('should export note with markdown format', async () => {
        const mockData = new Uint8Array([80, 75, 3, 4]).buffer;
        vi.mocked(mockClient.exportNote).mockResolvedValue(mockData);

        const result = await handleSystemTool(mockClient, 'export_note', {
          noteId: 'root',
          format: 'markdown',
        });

        expect(mockClient.exportNote).toHaveBeenCalledWith('root', 'markdown');
        const parsed = JSON.parse(result!.content[0].text);
        expect(parsed.format).toBe('markdown');
      });
    });

    it('should return null for unknown tool', async () => {
      const result = await handleSystemTool(mockClient, 'unknown_tool', {});
      expect(result).toBeNull();
    });
  });
});

describe('Tool count verification', () => {
  it('should have exactly 19 tools total', () => {
    const allTools = [
      ...registerNoteTools(),
      ...registerSearchTools(),
      ...registerOrganizationTools(),
      ...registerAttributeTools(),
      ...registerCalendarTools(),
      ...registerSystemTools(),
    ];
    expect(allTools).toHaveLength(19);
  });

  it('all tools should have descriptions', () => {
    const allTools = [
      ...registerNoteTools(),
      ...registerSearchTools(),
      ...registerOrganizationTools(),
      ...registerAttributeTools(),
      ...registerCalendarTools(),
      ...registerSystemTools(),
    ];
    allTools.forEach((tool) => {
      expect(tool.description).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(10);
    });
  });

  it('all tools should have valid input schemas', () => {
    const allTools = [
      ...registerNoteTools(),
      ...registerSearchTools(),
      ...registerOrganizationTools(),
      ...registerAttributeTools(),
      ...registerCalendarTools(),
      ...registerSystemTools(),
    ];
    allTools.forEach((tool) => {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    });
  });
});
