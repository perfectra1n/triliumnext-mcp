import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';

const getDayNoteSchema = z.object({
  date: z.string().optional().describe('Date in YYYY-MM-DD format (defaults to today)'),
});

const getInboxNoteSchema = z.object({
  date: z.string().optional().describe('Date in YYYY-MM-DD format (defaults to today)'),
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
    {
      name: 'get_day_note',
      description: 'Get or create the daily note for a specific date. Creates the note if it doesn\'t exist.',
      inputSchema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format (defaults to today)' },
        },
        required: [],
      },
    },
    {
      name: 'get_inbox_note',
      description: 'Get the inbox note for quick capture. The inbox can be a fixed note or a daily journal note depending on Trilium configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format (defaults to today)' },
        },
        required: [],
      },
    },
  ];
}

export async function handleCalendarTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
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
