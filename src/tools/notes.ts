import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import type { NoteType } from '../types/etapi.js';
import { defineTool } from './schemas.js';
import {
  noteTypeSchema,
  optionalEntityIdSchema,
  localDateTimeSchema,
  utcDateTimeSchema,
  positionSchema,
} from './validators.js';

// Zod schemas for validation
const createNoteSchema = z.object({
  parentNoteId: z.string().min(1, 'Parent note ID is required').describe('ID of the parent note (use "root" for top-level)'),
  title: z.string().min(1, 'Title is required').describe('Title of the new note'),
  type: noteTypeSchema.describe('Type of the note'),
  content: z.string().describe('Content of the note (HTML for text notes, raw code for code notes)'),
  mime: z.string().optional().describe('MIME type (required for code, file, image notes). Examples: application/javascript, text/x-python, text/markdown'),
  notePosition: positionSchema.optional().describe('Position in parent (10, 20, 30...). Use 5 for first position, 1000000 for last'),
  prefix: z.string().optional().describe('Branch-specific title prefix (e.g., "Archive:", "Draft:")'),
  isExpanded: z.boolean().optional().describe('Whether this note (as a folder) should appear expanded in the tree'),
  noteId: optionalEntityIdSchema.describe('Force a specific note ID (for imports/migrations). Must be 4-32 alphanumeric chars.'),
  branchId: optionalEntityIdSchema.describe('Force a specific branch ID (for imports/migrations). Must be 4-32 alphanumeric chars.'),
  dateCreated: localDateTimeSchema.optional().describe('Set creation date for backdating. Format: "2024-01-15 10:30:00.000+0100"'),
  utcDateCreated: utcDateTimeSchema.optional().describe('Set UTC creation date. Format: "2024-01-15 09:30:00.000Z"'),
});

const getNoteSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to retrieve'),
});

const getNoteContentSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to get content from'),
});

const updateNoteSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to update'),
  title: z.string().optional().describe('New title for the note'),
  type: noteTypeSchema.optional().describe('New type for the note'),
  mime: z.string().optional().describe('New MIME type for the note'),
});

const updateNoteContentSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to update'),
  content: z.string().describe('New content for the note'),
});

const deleteNoteSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to delete'),
});

export function registerNoteTools(): Tool[] {
  return [
    defineTool(
      'create_note',
      'Create a new note with title, content, type, and parent. Returns the created note and its branch. Supports positioning, tree display, and date options.',
      createNoteSchema
    ),
    defineTool(
      'get_note',
      'Get note metadata by ID. Returns note properties including title, type, attributes, and child/parent relationships.',
      getNoteSchema
    ),
    defineTool(
      'get_note_content',
      'Get the content/body of a note. For text notes, returns HTML. For code notes, returns the raw code.',
      getNoteContentSchema
    ),
    defineTool(
      'update_note',
      'Update note metadata (title, type, or MIME type). Does not update content - use update_note_content for that.',
      updateNoteSchema
    ),
    defineTool(
      'update_note_content',
      'Update the content/body of a note. For text notes, provide HTML. For code notes, provide raw code.',
      updateNoteContentSchema
    ),
    defineTool(
      'delete_note',
      'Delete a note by ID. This will also delete all branches pointing to this note.',
      deleteNoteSchema
    ),
  ];
}

export async function handleNoteTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  switch (name) {
    case 'create_note': {
      const parsed = createNoteSchema.parse(args);
      const result = await client.createNote({
        parentNoteId: parsed.parentNoteId,
        title: parsed.title,
        type: parsed.type as NoteType,
        content: parsed.content,
        mime: parsed.mime,
        notePosition: parsed.notePosition,
        prefix: parsed.prefix,
        isExpanded: parsed.isExpanded,
        noteId: parsed.noteId,
        branchId: parsed.branchId,
        dateCreated: parsed.dateCreated,
        utcDateCreated: parsed.utcDateCreated,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'get_note': {
      const parsed = getNoteSchema.parse(args);
      const result = await client.getNote(parsed.noteId);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'get_note_content': {
      const parsed = getNoteContentSchema.parse(args);
      const result = await client.getNoteContent(parsed.noteId);
      return {
        content: [{ type: 'text', text: result }],
      };
    }

    case 'update_note': {
      const parsed = updateNoteSchema.parse(args);
      const patch: { title?: string; type?: NoteType; mime?: string } = {};
      if (parsed.title) patch.title = parsed.title;
      if (parsed.type) patch.type = parsed.type as NoteType;
      if (parsed.mime) patch.mime = parsed.mime;
      const result = await client.updateNote(parsed.noteId, patch);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'update_note_content': {
      const parsed = updateNoteContentSchema.parse(args);
      await client.updateNoteContent(parsed.noteId, parsed.content);
      return {
        content: [{ type: 'text', text: 'Note content updated successfully' }],
      };
    }

    case 'delete_note': {
      const parsed = deleteNoteSchema.parse(args);
      await client.deleteNote(parsed.noteId);
      return {
        content: [{ type: 'text', text: `Note ${parsed.noteId} deleted successfully` }],
      };
    }

    default:
      return null;
  }
}
