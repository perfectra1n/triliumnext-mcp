import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TriliumClient, TriliumClientError } from '../../src/client/trilium.js';

describe('TriliumClient', () => {
  let client: TriliumClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new TriliumClient('http://localhost:37740/etapi', 'test-token');
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getNote', () => {
    it('should fetch a note by ID', async () => {
      const mockNote = {
        noteId: 'abc123',
        title: 'Test Note',
        type: 'text',
        mime: 'text/html',
        isProtected: false,
        attributes: [],
        parentNoteIds: ['root'],
        childNoteIds: [],
        parentBranchIds: ['branch1'],
        childBranchIds: [],
        dateCreated: '2024-01-01 12:00:00.000+0000',
        dateModified: '2024-01-01 12:00:00.000+0000',
        utcDateCreated: '2024-01-01 12:00:00.000Z',
        utcDateModified: '2024-01-01 12:00:00.000Z',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockNote,
      });

      const result = await client.getNote('abc123');
      expect(result).toEqual(mockNote);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:37740/etapi/notes/abc123',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'test-token',
          }),
        })
      );
    });

    it('should throw TriliumClientError on API error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({
          status: 404,
          code: 'NOTE_NOT_FOUND',
          message: 'Note not found',
        }),
      });

      await expect(client.getNote('nonexistent')).rejects.toThrow(TriliumClientError);

      try {
        await client.getNote('nonexistent');
      } catch (e) {
        expect(e).toBeInstanceOf(TriliumClientError);
        expect((e as TriliumClientError).status).toBe(404);
        expect((e as TriliumClientError).code).toBe('NOTE_NOT_FOUND');
      }
    });
  });

  describe('note URLs', () => {
    it('derives the web base by stripping /etapi from the base URL', () => {
      expect(client.getWebBaseUrl()).toBe('http://localhost:37740');
    });

    it('uses an explicit web base override when provided', () => {
      const overridden = new TriliumClient(
        'http://internal:37740/etapi',
        'tok',
        'https://trilium.example.com/'
      );
      expect(overridden.getWebBaseUrl()).toBe('https://trilium.example.com');
    });

    it('builds a full-path URL by walking parentNoteIds to root', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ parentNoteIds: ['mid'] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ parentNoteIds: ['root'] }) });

      const url = await client.getNoteUrl('leaf');
      expect(url).toBe('http://localhost:37740/#root/mid/leaf');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('uses the parent hint for the first hop to save a fetch', async () => {
      // Only the grandparent ("mid") should be fetched; the immediate parent is supplied.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ parentNoteIds: ['root'] }),
      });

      const url = await client.getNoteUrl('leaf', 'mid');
      expect(url).toBe('http://localhost:37740/#root/mid/leaf');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns a root-anchored link for a note directly under root', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ parentNoteIds: ['root'] }),
      });

      const url = await client.getNoteUrl('topnote');
      expect(url).toBe('http://localhost:37740/#root/topnote');
    });

    it('falls back to a bare noteId link when an ancestor lookup fails', async () => {
      mockFetch.mockRejectedValue(new Error('network down'));

      const url = await client.getNoteUrl('leaf');
      expect(url).toBe('http://localhost:37740/#leaf');
    });

    it('returns just root for the root note without any fetch', async () => {
      const url = await client.getNoteUrl('root');
      expect(url).toBe('http://localhost:37740/#root');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('createNote', () => {
    it('should create a note with the correct body', async () => {
      const mockResult = {
        note: {
          noteId: 'new123',
          title: 'New Note',
          type: 'text',
        },
        branch: {
          branchId: 'branch123',
          noteId: 'new123',
          parentNoteId: 'root',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockResult,
      });

      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'New Note',
        type: 'text',
        content: '<p>Hello world</p>',
      });

      expect(result).toEqual(mockResult);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:37740/etapi/create-note',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            parentNoteId: 'root',
            title: 'New Note',
            type: 'text',
            content: '<p>Hello world</p>',
          }),
        })
      );
    });
  });

  describe('getNoteContent', () => {
    it('should return note content as text', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '<p>Hello world</p>',
      });

      const result = await client.getNoteContent('abc123');
      expect(result).toBe('<p>Hello world</p>');
    });
  });

  describe('updateNoteContent', () => {
    it('should update note content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await client.updateNoteContent('abc123', '<p>Updated content</p>');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:37740/etapi/notes/abc123/content',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'Content-Type': 'text/plain',
          }),
          body: '<p>Updated content</p>',
        })
      );
    });
  });

  describe('deleteNote', () => {
    it('should delete a note', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await client.deleteNote('abc123');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:37740/etapi/notes/abc123',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });
  });

  describe('searchNotes', () => {
    it('should search with query parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      });

      await client.searchNotes({
        search: 'test query',
        limit: 10,
        orderBy: 'title',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('search=test+query'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=10'),
        expect.any(Object)
      );
    });
  });

  describe('calendar endpoints', () => {
    it('should get day note', async () => {
      const mockNote = { noteId: 'day123', title: 'Day Note' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockNote,
      });

      const result = await client.getDayNote('2024-01-15');
      expect(result).toEqual(mockNote);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:37740/etapi/calendar/days/2024-01-15',
        expect.any(Object)
      );
    });

    it('should get inbox note', async () => {
      const mockNote = { noteId: 'inbox123', title: 'Inbox' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockNote,
      });

      const result = await client.getInboxNote('2024-01-15');
      expect(result).toEqual(mockNote);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:37740/etapi/inbox/2024-01-15',
        expect.any(Object)
      );
    });
  });

  describe('URL handling', () => {
    it('should remove trailing slash from base URL', async () => {
      const clientWithSlash = new TriliumClient('http://localhost:37740/etapi/', 'token');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await clientWithSlash.getNote('test');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:37740/etapi/notes/test',
        expect.any(Object)
      );
    });
  });

  describe('exportNote', () => {
    it('parses the ETAPI error body on failure instead of a generic EXPORT_ERROR', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ status: 404, code: 'NOTE_NOT_FOUND', message: 'Note not found' }),
      });

      try {
        await client.exportNote('gone');
        expect.unreachable('exportNote should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TriliumClientError);
        expect((e as TriliumClientError).code).toBe('NOTE_NOT_FOUND');
        expect((e as TriliumClientError).message).toBe('Note not found');
      }
    });
  });

  describe('importZip', () => {
    it('POSTs the raw ZIP bytes as application/octet-stream and returns the created note', async () => {
      const noteWithBranch = { note: { noteId: 'newN' }, branch: { branchId: 'newB' } };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => noteWithBranch,
      });

      const buf = Buffer.from('PK-fake-zip');
      const result = await client.importZip('parent1', buf);

      expect(result).toEqual(noteWithBranch);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:37740/etapi/notes/parent1/import',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/octet-stream' }),
          body: buf,
        })
      );
    });
  });
});
