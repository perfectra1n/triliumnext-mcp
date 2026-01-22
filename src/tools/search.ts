import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { orderDirectionSchema, searchLimitSchema } from './validators.js';

const searchNotesSchema = z.object({
  query: z
    .string()
    .min(1, 'Search query is required')
    .describe('Search query string. Use #label for labels, ~relation for relations.'),
  fastSearch: z.boolean().optional().describe('Enable fast search (skips content search)'),
  includeArchivedNotes: z.boolean().optional().describe('Include archived notes'),
  ancestorNoteId: z.string().optional().describe('Search only in subtree of this note'),
  orderBy: z
    .string()
    .optional()
    .describe('Property to order by (title, dateCreated, dateModified)'),
  orderDirection: orderDirectionSchema.optional().describe('Order direction'),
  limit: searchLimitSchema.optional().describe('Maximum number of results'),
});

const getNoteTreeSchema = z.object({
  noteId: z
    .string()
    .min(1, 'Note ID is required')
    .describe('ID of the parent note (use "root" for the root note)'),
});

export function registerSearchTools(): Tool[] {
  return [
    defineTool(
      'search_notes',
      'Search notes using full-text search and/or attribute filters. Supports Trilium search syntax including #label and ~relation filters.',
      searchNotesSchema
    ),
    defineTool(
      'get_note_tree',
      'Get children of a note for tree navigation. Returns the note with its childNoteIds populated.',
      getNoteTreeSchema
    ),
  ];
}

export async function handleSearchTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
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
