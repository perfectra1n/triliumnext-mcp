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
});
