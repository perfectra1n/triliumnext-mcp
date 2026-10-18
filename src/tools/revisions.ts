import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { TriliumClientError } from '../client/trilium.js';
import type { PatchNoteDef } from '../types/etapi.js';
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

const restoreRevisionSchema = z.object({
  revisionId: z
    .string()
    .min(1, 'Revision ID is required')
    .describe('ID of the revision to restore (from get_revisions with a noteId).'),
  snapshot_current: z
    .boolean()
    .default(true)
    .describe(
      "Snapshot the note's CURRENT state as a new revision before restoring (default true), so the " +
        'restore itself can be undone. Only disable this if the user explicitly does not want it.'
    ),
  restore_title: z
    .boolean()
    .default(true)
    .describe('Also restore the title the note had in that revision (default true).'),
});

/** Note types whose body is a binary blob rather than text/HTML. */
const BINARY_NOTE_TYPES = new Set(['image', 'file']);

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
    defineTool(
      'restore_revision',
      "Restore a note to one of its revisions: writes the revision's content (and, by default, title) back " +
        'onto the live note. By default the current state is snapshotted first with create_revision, so the ' +
        'restore is reversible. Find revision IDs with get_revisions {noteId}; preview one with ' +
        'get_revisions {revisionId}. Protected notes cannot be restored through ETAPI. ' +
        'The response includes the note url — give it to the user when you are done.',
      restoreRevisionSchema,
      {
        title: 'Restore revision',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      }
    ),
  ];
}

export async function handleRevisionTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
  if (name === 'restore_revision') return restoreRevision(client, args);
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

async function restoreRevision(
  client: TriliumClient,
  args: unknown
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const parsed = restoreRevisionSchema.parse(args);
  const revision = await client.getRevision(parsed.revisionId);
  const note = await client.getNote(revision.noteId);

  if (revision.isProtected || note.isProtected) {
    throw new TriliumClientError(
      400,
      'NOTE_IS_PROTECTED',
      `Revision '${revision.revisionId}' belongs to a protected note; ETAPI cannot read or write protected content.`
    );
  }

  if (parsed.snapshot_current) {
    await client.createRevision(note.noteId);
  }

  // Type/mime first: switching e.g. code -> text changes how the body is stored.
  const patch: PatchNoteDef = {};
  if (revision.type !== note.type) patch.type = revision.type;
  if (revision.mime !== note.mime) patch.mime = revision.mime;
  if (parsed.restore_title && revision.title !== note.title) patch.title = revision.title;
  if (Object.keys(patch).length > 0) {
    await client.updateNote(note.noteId, patch);
  }

  if (BINARY_NOTE_TYPES.has(revision.type)) {
    const body = await client.getRevisionContentBinary(revision.revisionId);
    await client.updateNoteContentBinary(note.noteId, body);
  } else {
    const body = await client.getRevisionContent(revision.revisionId);
    await client.updateNoteContent(note.noteId, body);
  }

  const url = await client.getNoteUrl(note.noteId);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            success: true,
            noteId: note.noteId,
            restoredRevisionId: revision.revisionId,
            revisionDate: revision.dateLastEdited,
            snapshotOfPreviousStateCreated: parsed.snapshot_current,
            metadataRestored: patch,
            url,
          },
          null,
          2
        ),
      },
    ],
  };
}
