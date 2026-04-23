import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { required } from './validators.js';

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
      .describe('If provided, returns a single revision. Use include_content to also fetch the body.'),
    include_content: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Only meaningful with "revisionId". When true, returns the HTML content of the revision snapshot. ' +
          'Default false returns metadata only.'
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
      'Get note revisions (historical snapshots). Three uses depending on inputs:\n' +
        '- Pass "noteId" to list all revisions for that note (metadata only)\n' +
        '- Pass "revisionId" to fetch a single revision (metadata)\n' +
        '- Pass "revisionId" with include_content=true to fetch the revision\'s HTML content\n\n' +
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
    return { content: [{ type: 'text', text: content }] };
  }

  const revision = await client.getRevision(revisionId);
  return {
    content: [{ type: 'text', text: JSON.stringify(revision, null, 2) }],
  };
}
