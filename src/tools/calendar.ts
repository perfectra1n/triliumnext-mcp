import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { dateSchema, weekSchema, monthSchema, yearSchema } from './validators.js';

const DATE_FORMAT_BY_KIND = {
  day: { schema: dateSchema, hint: 'YYYY-MM-DD' },
  inbox: { schema: dateSchema, hint: 'YYYY-MM-DD' },
  week: { schema: weekSchema, hint: 'YYYY-Www (ISO week, e.g. 2026-W03)' },
  month: { schema: monthSchema, hint: 'YYYY-MM' },
  year: { schema: yearSchema, hint: 'YYYY' },
} as const;

const getSpecialNoteSchema = z
  .object({
    kind: z
      .enum(['day', 'week', 'month', 'year', 'inbox'])
      .describe(
        '"day" — the daily journal note. "week"/"month"/"year" — the corresponding periodic journal note ' +
          '(for weekly/monthly/yearly reviews). All are created if missing. ' +
          '"inbox" — the quick-capture inbox note (may be a fixed note or the daily note depending on Trilium configuration).'
      ),
    date: z
      .string()
      .optional()
      .describe(
        'Which period to fetch; format depends on kind — day/inbox: YYYY-MM-DD, week: YYYY-Www ' +
          '(ISO week, e.g. 2026-W03), month: YYYY-MM, year: YYYY. Defaults to the current day/week/month/year.'
      ),
  })
  .check((ctx) => {
    const { kind, date } = ctx.value;
    if (date === undefined) return;
    const expected = DATE_FORMAT_BY_KIND[kind];
    if (!expected.schema.safeParse(date).success) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: `Invalid date for kind="${kind}". Expected format: ${expected.hint}`,
        path: ['date'],
      });
    }
  });

function getTodayDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * ISO 8601 week string (YYYY-Www) for a date, using the ISO week-numbering
 * year — around New Year this can differ from the calendar year (Dec 29-31
 * may fall in next year's W01; Jan 1-3 in the prior year's W52/W53).
 */
export function isoWeekString(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7; // Mon=1 .. Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // shift to nearest Thursday
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function registerCalendarTools(): Tool[] {
  return [
    defineTool(
      'get_special_note',
      'Get a periodic journal note or the inbox note. kind="day" fetches the daily note, "week"/"month"/"year" ' +
        'fetch the corresponding periodic notes (useful for weekly/monthly/yearly reviews) — all auto-created if ' +
        'missing. kind="inbox" fetches the quick-capture inbox (configuration-dependent: either a fixed note or ' +
        'the daily note). The date format follows the kind (YYYY-MM-DD, YYYY-Www, YYYY-MM, or YYYY) and defaults ' +
        'to the current period.',
      getSpecialNoteSchema,
      { title: 'Get periodic or inbox note', readOnlyHint: false, idempotentHint: true }
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
  const today = getTodayDate();

  let note;
  switch (parsed.kind) {
    case 'day':
      note = await client.getDayNote(parsed.date ?? today);
      break;
    case 'inbox':
      note = await client.getInboxNote(parsed.date ?? today);
      break;
    case 'week':
      note = await client.getWeekNote(parsed.date ?? isoWeekString(new Date()));
      break;
    case 'month':
      note = await client.getMonthNote(parsed.date ?? today.slice(0, 7));
      break;
    case 'year':
      note = await client.getYearNote(parsed.date ?? today.slice(0, 4));
      break;
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(note, null, 2) }],
  };
}
