import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { dateSchema } from './validators.js';

const getDayNoteSchema = z.object({
  date: dateSchema.optional().describe('Date in YYYY-MM-DD format (defaults to today)'),
});

const getInboxNoteSchema = z.object({
  date: dateSchema.optional().describe('Date in YYYY-MM-DD format (defaults to today)'),
});

function getTodayDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function registerCalendarTools(): Tool[] {
  return [
    defineTool(
      'get_day_note',
      "Get or create the daily note for a specific date. Creates the note if it doesn't exist.",
      getDayNoteSchema
    ),
    defineTool(
      'get_inbox_note',
      'Get the inbox note for quick capture. The inbox can be a fixed note or a daily journal note depending on Trilium configuration.',
      getInboxNoteSchema
    ),
  ];
}

export async function handleCalendarTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
  switch (name) {
    case 'get_day_note': {
      const parsed = getDayNoteSchema.parse(args);
      const date = parsed.date ?? getTodayDate();
      const note = await client.getDayNote(date);
      return {
        content: [{ type: 'text', text: JSON.stringify(note, null, 2) }],
      };
    }

    case 'get_inbox_note': {
      const parsed = getInboxNoteSchema.parse(args);
      const date = parsed.date ?? getTodayDate();
      const note = await client.getInboxNote(date);
      return {
        content: [{ type: 'text', text: JSON.stringify(note, null, 2) }],
      };
    }

    default:
      return null;
  }
}
