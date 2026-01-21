import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerNoteTools, handleNoteTool } from '../../src/tools/notes.js';
import { registerSearchTools, handleSearchTool } from '../../src/tools/search.js';
import { registerOrganizationTools, handleOrganizationTool } from '../../src/tools/organization.js';
import { registerAttributeTools, handleAttributeTool } from '../../src/tools/attributes.js';
import { registerCalendarTools, handleCalendarTool } from '../../src/tools/calendar.js';
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
    ...overrides,
  } as unknown as TriliumClient;
}

describe('Note Tools', () => {
  describe('registerNoteTools', () => {
    it('should register 6 note tools', () => {
      const tools = registerNoteTools();
      expect(tools).toHaveLength(6);
      expect(tools.map(t => t.name)).toEqual([
        'create_note',
        'get_note',
        'get_note_content',
        'update_note',
        'update_note_content',
        'delete_note',
      ]);
    });
  });

  describe('handleNoteTool', () => {
    let mockClient: TriliumClient;

    beforeEach(() => {
      mockClient = createMockClient();
    });

    it('should handle create_note', async () => {
      const mockResult = { note: { noteId: 'new123' }, branch: { branchId: 'branch123' } };
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
      });
    });

    it('should handle get_note', async () => {
      const mockNote = { noteId: 'abc123', title: 'Test Note' };
      vi.mocked(mockClient.getNote).mockResolvedValue(mockNote as any);

      const result = await handleNoteTool(mockClient, 'get_note', { noteId: 'abc123' });

      expect(result).not.toBeNull();
      expect(mockClient.getNote).toHaveBeenCalledWith('abc123');
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
      expect(tools.map(t => t.name)).toEqual(['search_notes', 'get_note_tree']);
    });
  });

  describe('handleSearchTool', () => {
    let mockClient: TriliumClient;

    beforeEach(() => {
      mockClient = createMockClient();
    });

    it('should handle search_notes', async () => {
      vi.mocked(mockClient.searchNotes).mockResolvedValue({ results: [] });

      const result = await handleSearchTool(mockClient, 'search_notes', {
        query: 'test query',
        limit: 10,
      });

      expect(result).not.toBeNull();
      expect(mockClient.searchNotes).toHaveBeenCalledWith({
        search: 'test query',
        limit: 10,
        fastSearch: undefined,
        includeArchivedNotes: undefined,
        ancestorNoteId: undefined,
        orderBy: undefined,
        orderDirection: undefined,
      });
    });

    it('should handle get_note_tree', async () => {
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
      expect(result!.content[0].text).toContain('child1');
    });
  });
});

describe('Organization Tools', () => {
  describe('registerOrganizationTools', () => {
    it('should register 3 organization tools', () => {
      const tools = registerOrganizationTools();
      expect(tools).toHaveLength(3);
      expect(tools.map(t => t.name)).toEqual(['move_note', 'clone_note', 'reorder_notes']);
    });
  });

  describe('handleOrganizationTool', () => {
    let mockClient: TriliumClient;

    beforeEach(() => {
      mockClient = createMockClient();
    });

    it('should handle clone_note', async () => {
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
  });
});

describe('Attribute Tools', () => {
  describe('registerAttributeTools', () => {
    it('should register 3 attribute tools', () => {
      const tools = registerAttributeTools();
      expect(tools).toHaveLength(3);
      expect(tools.map(t => t.name)).toEqual(['get_attributes', 'set_attribute', 'delete_attribute']);
    });
  });

  describe('handleAttributeTool', () => {
    let mockClient: TriliumClient;

    beforeEach(() => {
      mockClient = createMockClient();
    });

    it('should handle get_attributes', async () => {
      const mockNote = {
        noteId: 'abc123',
        attributes: [
          { attributeId: 'attr1', type: 'label', name: 'tag', value: 'test' },
          { attributeId: 'attr2', type: 'relation', name: 'parent', value: 'root' },
        ],
      };
      vi.mocked(mockClient.getNote).mockResolvedValue(mockNote as any);

      const result = await handleAttributeTool(mockClient, 'get_attributes', { noteId: 'abc123' });

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.labels).toHaveLength(1);
      expect(parsed.relations).toHaveLength(1);
    });

    it('should create new attribute when not exists', async () => {
      vi.mocked(mockClient.getNote).mockResolvedValue({ attributes: [] } as any);
      vi.mocked(mockClient.createAttribute).mockResolvedValue({ attributeId: 'new' } as any);

      await handleAttributeTool(mockClient, 'set_attribute', {
        noteId: 'abc123',
        type: 'label',
        name: 'priority',
        value: 'high',
      });

      expect(mockClient.createAttribute).toHaveBeenCalled();
      expect(mockClient.updateAttribute).not.toHaveBeenCalled();
    });

    it('should update existing attribute', async () => {
      vi.mocked(mockClient.getNote).mockResolvedValue({
        attributes: [{ attributeId: 'existing', type: 'label', name: 'priority', value: 'low' }],
      } as any);
      vi.mocked(mockClient.updateAttribute).mockResolvedValue({ attributeId: 'existing' } as any);

      await handleAttributeTool(mockClient, 'set_attribute', {
        noteId: 'abc123',
        type: 'label',
        name: 'priority',
        value: 'high',
      });

      expect(mockClient.updateAttribute).toHaveBeenCalledWith('existing', { value: 'high' });
      expect(mockClient.createAttribute).not.toHaveBeenCalled();
    });
  });
});

describe('Calendar Tools', () => {
  describe('registerCalendarTools', () => {
    it('should register 2 calendar tools', () => {
      const tools = registerCalendarTools();
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.name)).toEqual(['get_day_note', 'get_inbox_note']);
    });
  });

  describe('handleCalendarTool', () => {
    let mockClient: TriliumClient;

    beforeEach(() => {
      mockClient = createMockClient();
    });

    it('should handle get_day_note with specific date', async () => {
      vi.mocked(mockClient.getDayNote).mockResolvedValue({ noteId: 'day123' } as any);

      await handleCalendarTool(mockClient, 'get_day_note', { date: '2024-01-15' });

      expect(mockClient.getDayNote).toHaveBeenCalledWith('2024-01-15');
    });

    it('should handle get_day_note with default date', async () => {
      vi.mocked(mockClient.getDayNote).mockResolvedValue({ noteId: 'day123' } as any);

      await handleCalendarTool(mockClient, 'get_day_note', {});

      expect(mockClient.getDayNote).toHaveBeenCalled();
      // Should be called with today's date in YYYY-MM-DD format
      const callArg = vi.mocked(mockClient.getDayNote).mock.calls[0][0];
      expect(callArg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

describe('Tool count verification', () => {
  it('should have exactly 16 tools total', () => {
    const allTools = [
      ...registerNoteTools(),
      ...registerSearchTools(),
      ...registerOrganizationTools(),
      ...registerAttributeTools(),
      ...registerCalendarTools(),
    ];
    expect(allTools).toHaveLength(16);
  });
});
