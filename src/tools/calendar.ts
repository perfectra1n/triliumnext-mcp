import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool, type ToolHandlerResult } from './schemas.js';

/**
 * Validate a calendar period string for `kind`. Returns an error message, or
 * null when valid. Checks real dates (no 2024-02-30, month 13, or W53 in a
 * 52-week year), not just the shape.
 */
export function validatePeriod(kind: SpecialNoteKind, value: string): string | null {
  switch (kind) {
    case 'day':
    case 'inbox':
    case 'week_first_day': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!m) return `Expected YYYY-MM-DD (e.g. 2026-01-15), got "${value}".`;
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (mo < 1 || mo > 12) return `Month ${m[2]} is out of range 01-12 in "${value}".`;
      const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      if (d < 1 || d > daysInMonth) {
        return `Day ${m[3]} is out of range for ${m[1]}-${m[2]} (01-${daysInMonth}) in "${value}".`;
      }
      return null;
    }
    case 'week': {
      const m = /^(\d{4})-W(\d{2})$/.exec(value);
      if (!m) return `Expected YYYY-Www (ISO week, e.g. 2026-W03), got "${value}".`;
      const [y, w] = [Number(m[1]), Number(m[2])];
      // Dec 28 is always in the ISO year's last week.
      const weeksInYear = Number(isoWeekString(new Date(y, 11, 28)).slice(6));
      if (w < 1 || w > weeksInYear) {
        return `Week ${m[2]} is out of range for ISO year ${m[1]} (W01-W${weeksInYear}).`;
      }
      return null;
    }
    case 'month': {
      const m = /^(\d{4})-(\d{2})$/.exec(value);
      if (!m) return `Expected YYYY-MM (e.g. 2026-01), got "${value}".`;
      const mo = Number(m[2]);
      if (mo < 1 || mo > 12) return `Month ${m[2]} is out of range 01-12 in "${value}".`;
      return null;
    }
    case 'year':
      return /^\d{4}$/.test(value) ? null : `Expected YYYY (e.g. 2026), got "${value}".`;
  }
}

const SPECIAL_NOTE_KINDS = ['day', 'week', 'month', 'year', 'inbox', 'week_first_day'] as const;
type SpecialNoteKind = (typeof SPECIAL_NOTE_KINDS)[number];

const getSpecialNoteSchema = z
  .object({
    kind: z
      .enum(SPECIAL_NOTE_KINDS)
      .describe(
        '"day"/"week"/"month"/"year": that journal note, created if missing. "inbox": the quick-capture ' +
          'inbox (a fixed note or the day note, per Trilium settings). "week_first_day": the day note ' +
          'for the first day of the week containing date (works without week notes enabled; needs a ' +
          'recent Trilium).'
      ),
    date: z
      .string()
      .optional()
      .describe(
        'Period to fetch: YYYY-MM-DD for day/inbox/week_first_day, YYYY-Www (ISO week) for week, ' +
          "YYYY-MM for month, YYYY for year. Defaults to the current period in the MCP server's timezone."
      ),
  })
  .check((ctx) => {
    const { kind, date } = ctx.value;
    if (date === undefined) return;
    const problem = validatePeriod(kind, date);
    if (problem !== null) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: `Invalid date for kind="${kind}": ${problem}`,
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
      'Get (creating if missing) a day/week/month/year journal note, the inbox note, or the first day ' +
        'of a week. Returns the note metadata; read its body with get_note.',
      getSpecialNoteSchema,
      {
        title: 'Get periodic or inbox note',
        // May create the journal note on first call, so not read-only — but
        // repeat calls return the same note and nothing is ever removed.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      }
    ),
  ];
}

export async function handleCalendarTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<ToolHandlerResult> {
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
    case 'week_first_day':
      note = await client.getWeekFirstDayNote(parsed.date ?? today);
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
