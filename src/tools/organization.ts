import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import type { Branch } from '../types/etapi.js';
import { defineTool } from './schemas.js';
import { positionSchema, required } from './validators.js';

const organizeNoteSchema = z
  .object({
    action: z
      .enum(['move', 'clone', 'reorder', 'unlink'])
      .describe(
        'Operation to perform. ' +
          '"move" — move a note to a new parent (fields: noteId, newParentNoteId, fromParentNoteId?, prefix?). ' +
          '"clone" — make a note appear under an additional parent (fields: noteId, parentNoteId, prefix?). ' +
          '"reorder" — change display order of children under a parent (fields: parentNoteId, notePositions[]). ' +
          '"unlink" — remove a specific parent-child branch (field: branchId). WARNING: removing a note\'s last branch deletes the note.'
      ),
    noteId: z.string().optional().describe('ID of the note. Required for "move" and "clone".'),
    newParentNoteId: z
      .string()
      .optional()
      .describe(
        'Destination parent for "move". Use search_notes/get_note_tree to pick the right parent.'
      ),
    fromParentNoteId: z
      .string()
      .optional()
      .describe(
        'Optional for "move": the parent to move the note AWAY from. Required when the note is cloned ' +
          '(has several parents) so the right placement is moved; ignored otherwise.'
      ),
    parentNoteId: z
      .string()
      .optional()
      .describe(
        'Parent note ID. Required for "clone" (destination) and "reorder" (owner of the ordering).'
      ),
    prefix: z
      .string()
      .optional()
      .describe('Optional branch prefix for "move" and "clone" (e.g., "Archive:", "Draft:").'),
    notePositions: z
      .array(
        z.object({
          branchId: z.string().min(1).describe('ID of the branch to reorder'),
          notePosition: positionSchema.describe('New position (10, 20, 30...)'),
        })
      )
      .optional()
      .describe('Required for "reorder": array of branch position updates.'),
    branchId: z
      .string()
      .optional()
      .describe('Required for "unlink": the branch (parent-child link) to remove.'),
  })
  .check((ctx) => {
    const { action, noteId, newParentNoteId, parentNoteId, notePositions, branchId } = ctx.value;
    if (action === 'move') {
      if (!noteId || !newParentNoteId) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'action="move" requires "noteId" and "newParentNoteId"',
          path: [],
        });
      }
    } else if (action === 'clone') {
      if (!noteId || !parentNoteId) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'action="clone" requires "noteId" and "parentNoteId"',
          path: [],
        });
      }
    } else if (action === 'reorder') {
      if (!parentNoteId || !notePositions || notePositions.length === 0) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'action="reorder" requires "parentNoteId" and a non-empty "notePositions" array',
          path: [],
        });
      }
    } else if (action === 'unlink') {
      if (!branchId) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'action="unlink" requires "branchId"',
          path: ['branchId'],
        });
      }
    }
  });

/**
 * Decide which existing placement a "move" takes the note away from.
 *
 * Returns undefined when there is nothing to remove (the note is already under
 * the destination and nowhere else that was asked for). Throws rather than
 * guessing when a cloned note's source is ambiguous — silently unlinking the
 * wrong clone is a data-loss bug, not a convenience.
 */
export function pickSourceBranch(
  noteId: string,
  parentBranches: Branch[],
  newParentNoteId: string,
  fromParentNoteId: string | undefined
): Branch | undefined {
  if (fromParentNoteId !== undefined) {
    const match = parentBranches.find((b) => b.parentNoteId === fromParentNoteId);
    if (!match) {
      const parents = parentBranches.map((b) => b.parentNoteId).join(', ') || '(none)';
      throw new Error(
        `Note '${noteId}' is not a child of fromParentNoteId '${fromParentNoteId}'. Current parents: ${parents}.`
      );
    }
    return match.parentNoteId === newParentNoteId ? undefined : match;
  }

  const candidates = parentBranches.filter((b) => b.parentNoteId !== newParentNoteId);
  if (candidates.length <= 1) return candidates[0];

  throw new Error(
    `Note '${noteId}' is cloned under several parents (${candidates
      .map((b) => b.parentNoteId)
      .join(', ')}). Pass "fromParentNoteId" to say which placement to move, ` +
      'or use action="clone" to add a placement without removing any.'
  );
}

export function registerOrganizationTools(): Tool[] {
  return [
    defineTool(
      'organize_note',
      'Reorganize the note tree. Four actions selected via "action":\n' +
        '- "move": relocate a note to a new parent (creates the destination placement, then removes the old one). ' +
        'For a cloned note (several parents) pass fromParentNoteId to choose which placement moves; ' +
        'moving onto a parent the note is already under is a safe no-op\n' +
        '- "clone": make a note appear in multiple locations (new branch pointing to same note)\n' +
        '- "reorder": change display order of notes under a parent by updating branch positions\n' +
        '- "unlink": remove a specific parent-child branch without deleting the note (unless it\'s the last branch)\n\n' +
        'IMPORTANT: Before "move" or "clone", use search_notes and get_note_tree to explore the hierarchy and suggest the right destination. ' +
        'Branch IDs (for "reorder"/"unlink") come from get_note (parentBranchIds/childBranchIds) or get_note_tree (childBranchIds on each node). ' +
        'WARNING: "unlink" on the last branch of a note deletes the note itself. ' +
        'For "move" and "clone", the response includes a "url" field linking to the note at its new location — give it to the user when you are done.',
      organizeNoteSchema,
      { title: 'Organize notes', readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    ),
  ];
}

export async function handleOrganizationTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
  if (name !== 'organize_note') return null;

  const parsed = organizeNoteSchema.parse(args);

  switch (parsed.action) {
    case 'move': {
      const noteId = required(parsed.noteId, 'noteId');
      const newParentNoteId = required(parsed.newParentNoteId, 'newParentNoteId');

      const note = await client.getNote(noteId);
      const parentBranches = await Promise.all(
        note.parentBranchIds.map((id) => client.getBranch(id))
      );
      const sourceBranch = pickSourceBranch(
        noteId,
        parentBranches,
        newParentNoteId,
        parsed.fromParentNoteId
      );

      // POST /branches is an upsert: when the note already sits under the
      // destination it returns that existing branch rather than a new one.
      // Create first so the note is never briefly orphaned, then delete the
      // source only if it is genuinely a different branch — otherwise a move
      // onto the current parent would delete the note's only placement.
      const newBranch = await client.createBranch({
        noteId,
        parentNoteId: newParentNoteId,
        prefix: parsed.prefix,
      });

      const removed =
        sourceBranch !== undefined && sourceBranch.branchId !== newBranch.branchId
          ? sourceBranch
          : undefined;
      if (removed) {
        await client.deleteBranch(removed.branchId);
      }

      const url = await client.getNoteUrl(noteId, newBranch.parentNoteId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                action: 'move',
                branch: newBranch,
                removedBranchId: removed?.branchId ?? null,
                fromParentNoteId: removed?.parentNoteId ?? null,
                ...(removed
                  ? {}
                  : { note: 'The note was already under this parent; nothing was moved.' }),
                url,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'clone': {
      const noteId = required(parsed.noteId, 'noteId');
      const parentNoteId = required(parsed.parentNoteId, 'parentNoteId');
      const branch = await client.createBranch({
        noteId,
        parentNoteId,
        prefix: parsed.prefix,
      });
      const url = await client.getNoteUrl(noteId, branch.parentNoteId);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ action: 'clone', branch, url }, null, 2) },
        ],
      };
    }

    case 'reorder': {
      const parentNoteId = required(parsed.parentNoteId, 'parentNoteId');
      const notePositions = required(parsed.notePositions, 'notePositions');

      const results = [];
      for (const pos of notePositions) {
        const updated = await client.updateBranch(pos.branchId, {
          notePosition: pos.notePosition,
        });
        results.push(updated);
      }

      await client.refreshNoteOrdering(parentNoteId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: true, action: 'reorder', updatedBranches: results },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'unlink': {
      const branchId = required(parsed.branchId, 'branchId');
      await client.deleteBranch(branchId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, action: 'unlink', branchId }, null, 2),
          },
        ],
      };
    }
  }
}
