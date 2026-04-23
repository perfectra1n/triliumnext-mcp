import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { dateSchema } from './validators.js';

const getSpecialNoteSchema = z.object({
  kind: z
    .enum(['day', 'inbox'])
    .describe(
      '"day" — the daily journal note for the given date (created if missing). ' +
        '"inbox" — the quick-capture inbox note (may be a fixed note or the daily note depending on Trilium configuration).'
    ),
  date: dateSchema
    .optional()
    .describe('Date in YYYY-MM-DD format (defaults to today).'),
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
      'get_special_note',
      'Get the daily journal or inbox note. Pass kind="day" for the daily note (auto-created if missing) ' +
        'or kind="inbox" for the quick-capture inbox (configuration-dependent: either a fixed note or the daily note).',
      getSpecialNoteSchema,
      { title: 'Get day or inbox note', readOnlyHint: false, idempotentHint: true }
    ),
  ];
}

export async function handleCalendarTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
  if (name !== 'get_special_note') return null;

  const parsed = getSpecialNoteSchema.parse(args);
  const date = parsed.date ?? getTodayDate();
  const note =
    parsed.kind === 'day' ? await client.getDayNote(date) : await client.getInboxNote(date);

  return {
    content: [{ type: 'text', text: JSON.stringify(note, null, 2) }],
  };
}
