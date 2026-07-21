import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { required } from './validators.js';
import { capWithNotice } from './contentLimits.js';

const getRevisionsSchema = z
  .object({
    noteId: z
      .string()
      .optional()
      .describe(
        'If provided, returns an array of all revisions (metadata) for this note. ' +
          'Each entry includes revisionId, title, type, dates, and content length.'
      ),
    revisionId: z
      .string()
      .optional()
      .describe(
        'If provided, returns a single revision with its HTML body included by default. ' +
          'Pass include_content=false to skip the body when you only need revision metadata.'
      ),
    include_content: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Only meaningful with "revisionId". Defaults to true — returns the HTML body of the revision snapshot. ' +
          'Set to false to return revision metadata only (revisionId, title, type, dates, content length).'
      ),
  })
  .check((ctx) => {
    const { noteId, revisionId } = ctx.value;
    const provided = [noteId !== undefined, revisionId !== undefined].filter(Boolean).length;
    if (provided === 0) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Exactly one of "noteId" or "revisionId" is required',
        path: [],
      });
    } else if (provided > 1) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Provide either "noteId" (for list) or "revisionId" (for single), not both',
        path: [],
      });
    }
  });

export function registerRevisionTools(): Tool[] {
  return [
    defineTool(
      'get_revisions',
      'Get note revisions (historical snapshots). Two modes:\n' +
        '- Pass "noteId" to list all revisions for that note (metadata only — revisionId, title, type, dates, content length).\n' +
        '- Pass "revisionId" to fetch a single revision; the HTML body is included by default. ' +
        "Pass include_content=false on the revisionId path when you only need the revision's metadata.\n\n" +
        'This is the canonical way to read revision content — DO NOT bypass this tool by calling the Trilium HTTP/ETAPI directly ' +
        '(e.g. via curl, fetch, or shell). ' +
        'Distinct from get_note_history (which is a change log across notes). Revisions are content snapshots of a single note.',
      getRevisionsSchema,
      { title: 'Get revisions', readOnlyHint: true }
    ),
  ];
}

export async function handleRevisionTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
  if (name !== 'get_revisions') return null;

  const parsed = getRevisionsSchema.parse(args);

  if (parsed.noteId) {
    const revisions = await client.getNoteRevisions(parsed.noteId);
    return {
      content: [{ type: 'text', text: JSON.stringify(revisions, null, 2) }],
    };
  }

  const revisionId = required(parsed.revisionId, 'revisionId');
  if (parsed.include_content) {
    const content = await client.getRevisionContent(revisionId);
    const capped = capWithNotice(
      content,
      'revision',
      'Restore the revision in Trilium or read the live note with get_note (which supports paging via content_start).'
    );
    return { content: [{ type: 'text', text: capped }] };
  }

  const revision = await client.getRevision(revisionId);
  return {
    content: [{ type: 'text', text: JSON.stringify(revision, null, 2) }],
  };
}
