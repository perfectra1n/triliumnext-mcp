import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { TriliumClientError } from '../client/trilium.js';
import type { PatchNoteDef } from '../types/etapi.js';
import { defineTool, type ToolHandlerResult } from './schemas.js';
import { entityIdSchema, required } from './validators.js';
import { capWithNotice } from './contentLimits.js';

const getRevisionsSchema = z
  .object({
    noteId: entityIdSchema.optional().describe('List all revisions of this note (metadata only).'),
    revisionId: entityIdSchema
      .optional()
      .describe('Fetch one revision; its body is returned unless include_content=false.'),
    include_content: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'With revisionId: true (default) returns the revision body; false returns its metadata ' +
          '(revisionId, title, type, dates, content length).'
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
  revisionId: entityIdSchema.describe('Revision to restore (from get_revisions {noteId}).'),
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
      'Read note revisions (content snapshots of one note). Pass noteId to list its revisions ' +
        '(metadata: revisionId, title, type, dates, content length), or revisionId to read one ' +
        "revision's body. For a change log across many notes use get_note_history instead.",
      getRevisionsSchema,
      { title: 'Get revisions', readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    ),
    defineTool(
      'restore_revision',
      "Restore a note to one of its revisions: writes the revision's content (and, by default, title) back " +
        'onto the live note. By default the current state is snapshotted first with create_revision, so the ' +
        'restore is reversible. Find revision IDs with get_revisions {noteId}; preview one with ' +
        'get_revisions {revisionId}. Protected notes cannot be restored through ETAPI.',
      restoreRevisionSchema,
      {
        title: 'Restore revision',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      }
    ),
  ];
}

export async function handleRevisionTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<ToolHandlerResult> {
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

  // Fetch the body before changing anything: if this read fails, the note is
  // left untouched instead of with restored metadata but its current body.
  const binary = BINARY_NOTE_TYPES.has(revision.type);
  const body = binary
    ? await client.getRevisionContentBinary(revision.revisionId)
    : await client.getRevisionContent(revision.revisionId);

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

  if (binary) {
    await client.updateNoteContentBinary(note.noteId, body as Buffer);
  } else {
    await client.updateNoteContent(note.noteId, body as string);
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
