import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool } from './schemas.js';

const getNoteRevisionsSchema = z.object({
  noteId: z.string().min(1).describe('ID of the note to get revisions for'),
});

const getRevisionSchema = z.object({
  revisionId: z.string().min(1).describe('ID of the revision to retrieve'),
});

const getRevisionContentSchema = z.object({
  revisionId: z.string().min(1).describe('ID of the revision to get content from'),
});

export function registerRevisionTools(): Tool[] {
  return [
    defineTool(
      'get_note_revisions',
      'Get all revisions (historical snapshots) for a note. Returns revision metadata including title, type, dates, and content length. Use get_revision_content to retrieve the actual content of a specific revision.',
      getNoteRevisionsSchema
    ),
    defineTool(
      'get_revision',
      'Get a single revision by its ID. Returns revision metadata including noteId, title, type, mime, dates, and content length.',
      getRevisionSchema
    ),
    defineTool(
      'get_revision_content',
      'Get the content/body of a revision. Returns the HTML content of the note at the time the revision was created.',
      getRevisionContentSchema
    ),
  ];
}

export async function handleRevisionTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
  switch (name) {
    case 'get_note_revisions': {
      const parsed = getNoteRevisionsSchema.parse(args);
      const revisions = await client.getNoteRevisions(parsed.noteId);
      return {
        content: [{ type: 'text', text: JSON.stringify(revisions, null, 2) }],
      };
    }
    case 'get_revision': {
      const parsed = getRevisionSchema.parse(args);
      const revision = await client.getRevision(parsed.revisionId);
      return {
        content: [{ type: 'text', text: JSON.stringify(revision, null, 2) }],
      };
    }
    case 'get_revision_content': {
      const parsed = getRevisionContentSchema.parse(args);
      const content = await client.getRevisionContent(parsed.revisionId);
      return { content: [{ type: 'text', text: content }] };
    }
    default:
      return null;
  }
}
