import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';

const searchNotesSchema = z.object({
  query: z.string().describe('Search query string'),
  fastSearch: z.boolean().optional().describe('Enable fast search (fulltext doesn\'t look into content)'),
  includeArchivedNotes: z.boolean().optional().describe('Include archived notes in results'),
  ancestorNoteId: z.string().optional().describe('Search only in subtree of this note'),
  orderBy: z.string().optional().describe('Property to order results by (title, dateCreated, dateModified)'),
  orderDirection: z.enum(['asc', 'desc']).optional().describe('Order direction'),
  limit: z.number().optional().describe('Maximum number of results'),
});

const getNoteTreeSchema = z.object({
  noteId: z.string().describe('ID of the parent note'),
});

export function registerSearchTools(): Tool[] {
  return [
    {
      name: 'search_notes',
      description: 'Search notes using full-text search and/or attribute filters. Supports Trilium search syntax including #label and ~relation filters.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query string. Use #label for labels, ~relation for relations.' },
          fastSearch: { type: 'boolean', description: 'Enable fast search (skips content search)' },
          includeArchivedNotes: { type: 'boolean', description: 'Include archived notes' },
          ancestorNoteId: { type: 'string', description: 'Search only in subtree of this note' },
          orderBy: { type: 'string', description: 'Property to order by (title, dateCreated, dateModified)' },
          orderDirection: { type: 'string', enum: ['asc', 'desc'], description: 'Order direction' },
          limit: { type: 'number', description: 'Maximum number of results' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_note_tree',
      description: 'Get children of a note for tree navigation. Returns the note with its childNoteIds populated.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'ID of the parent note (use "root" for the root note)' },
        },
        required: ['noteId'],
      },
    },
  ];
}

export async function handleSearchTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  switch (name) {
    case 'search_notes': {
      const parsed = searchNotesSchema.parse(args);
      const result = await client.searchNotes({
        search: parsed.query,
        fastSearch: parsed.fastSearch,
        includeArchivedNotes: parsed.includeArchivedNotes,
        ancestorNoteId: parsed.ancestorNoteId,
        orderBy: parsed.orderBy,
        orderDirection: parsed.orderDirection,
        limit: parsed.limit,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'get_note_tree': {
      const parsed = getNoteTreeSchema.parse(args);
      const note = await client.getNote(parsed.noteId);
      // Return a simplified view focused on tree navigation
      const treeView = {
        noteId: note.noteId,
        title: note.title,
        type: note.type,
        childNoteIds: note.childNoteIds,
        childBranchIds: note.childBranchIds,
        isExpanded: note.childNoteIds.length > 0,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(treeView, null, 2) }],
      };
    }

    default:
      return null;
  }
}
