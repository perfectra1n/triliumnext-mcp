import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import type { NoteType } from '../types/etapi.js';

// Zod schemas for validation
const createNoteSchema = z.object({
  parentNoteId: z.string().describe('ID of the parent note'),
  title: z.string().describe('Title of the new note'),
  type: z.enum(['text', 'code', 'file', 'image', 'search', 'book', 'relationMap', 'render']).describe('Type of the note'),
  content: z.string().describe('Content of the note (HTML for text notes)'),
  mime: z.string().optional().describe('MIME type (required for code, file, image notes)'),
});

const getNoteSchema = z.object({
  noteId: z.string().describe('ID of the note to retrieve'),
});

const getNoteContentSchema = z.object({
  noteId: z.string().describe('ID of the note to get content from'),
});

const updateNoteSchema = z.object({
  noteId: z.string().describe('ID of the note to update'),
  title: z.string().optional().describe('New title for the note'),
  type: z.enum(['text', 'code', 'file', 'image', 'search', 'book', 'relationMap', 'render']).optional().describe('New type for the note'),
  mime: z.string().optional().describe('New MIME type for the note'),
});

const updateNoteContentSchema = z.object({
  noteId: z.string().describe('ID of the note to update'),
  content: z.string().describe('New content for the note'),
});

const deleteNoteSchema = z.object({
  noteId: z.string().describe('ID of the note to delete'),
});

export function registerNoteTools(): Tool[] {
  return [
    {
      name: 'create_note',
      description: 'Create a new note with title, content, type, and parent. Returns the created note and its branch.',
      inputSchema: {
        type: 'object',
        properties: {
          parentNoteId: { type: 'string', description: 'ID of the parent note' },
          title: { type: 'string', description: 'Title of the new note' },
          type: {
            type: 'string',
            enum: ['text', 'code', 'file', 'image', 'search', 'book', 'relationMap', 'render'],
            description: 'Type of the note',
          },
          content: { type: 'string', description: 'Content of the note (HTML for text notes)' },
          mime: { type: 'string', description: 'MIME type (required for code, file, image notes)' },
        },
        required: ['parentNoteId', 'title', 'type', 'content'],
      },
    },
    {
      name: 'get_note',
      description: 'Get note metadata by ID. Returns note properties including title, type, attributes, and child/parent relationships.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'ID of the note to retrieve' },
        },
        required: ['noteId'],
      },
    },
    {
      name: 'get_note_content',
      description: 'Get the content/body of a note. For text notes, returns HTML. For code notes, returns the raw code.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'ID of the note to get content from' },
        },
        required: ['noteId'],
      },
    },
    {
      name: 'update_note',
      description: 'Update note metadata (title, type, or MIME type). Does not update content - use update_note_content for that.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'ID of the note to update' },
          title: { type: 'string', description: 'New title for the note' },
          type: {
            type: 'string',
            enum: ['text', 'code', 'file', 'image', 'search', 'book', 'relationMap', 'render'],
            description: 'New type for the note',
          },
          mime: { type: 'string', description: 'New MIME type for the note' },
        },
        required: ['noteId'],
      },
    },
    {
      name: 'update_note_content',
      description: 'Update the content/body of a note. For text notes, provide HTML. For code notes, provide raw code.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'ID of the note to update' },
          content: { type: 'string', description: 'New content for the note' },
        },
        required: ['noteId', 'content'],
      },
    },
    {
      name: 'delete_note',
      description: 'Delete a note by ID. This will also delete all branches pointing to this note.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'ID of the note to delete' },
        },
        required: ['noteId'],
      },
    },
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
