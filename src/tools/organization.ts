import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import type { Branch } from '../types/etapi.js';
import { defineTool, type ToolHandlerResult } from './schemas.js';
import { entityIdSchema, positionSchema, required } from './validators.js';

const organizeNoteSchema = z
  .object({
    action: z
      .enum(['move', 'clone', 'reorder', 'unlink'])
      .describe(
        '"move" (noteId, newParentNoteId, fromParentNoteId?, prefix?), "clone" (noteId, parentNoteId, ' +
          'prefix?), "reorder" (parentNoteId, notePositions), "unlink" (branchId).'
      ),
    noteId: entityIdSchema.optional().describe('Note to move or clone.'),
    newParentNoteId: entityIdSchema
      .optional()
      .describe('"move" only: destination parent. (clone uses parentNoteId instead.)'),
    fromParentNoteId: entityIdSchema
      .optional()
      .describe(
        '"move" only: the parent to move the note away from. Required when the note has two or more ' +
          'parents besides newParentNoteId; optional otherwise.'
      ),
    parentNoteId: entityIdSchema
      .optional()
      .describe(
        '"clone": the additional parent to place the note under. "reorder": the parent whose children ' +
          'are reordered.'
      ),
    prefix: z
      .string()
      .optional()
      .describe('"move"/"clone": branch title prefix shown in the tree (e.g. "Archive:").'),
    notePositions: z
      .array(
        z.object({
          branchId: entityIdSchema.describe('Child branch under parentNoteId.'),
          notePosition: positionSchema.describe('New position (10, 20, 30...).'),
        })
      )
      .optional()
      .describe('"reorder": new positions for child branches of parentNoteId.'),
    branchId: entityIdSchema.optional().describe('"unlink": the parent-child branch to remove.'),
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
      'Reorganize the note tree. Actions:\n' +
        '- "move": place the note under newParentNoteId and remove its old placement (the new branch is ' +
        'created first). If the note has several placements other than newParentNoteId, fromParentNoteId ' +
        'must say which to remove. If newParentNoteId is already a parent: with no other placement nothing ' +
        'changes; with exactly one other placement, that one is REMOVED (the note collapses onto ' +
        'newParentNoteId) — use "clone" instead to keep both.\n' +
        '- "clone": add a placement under parentNoteId without removing any (same note, new branch).\n' +
        '- "reorder": set notePosition on child branches of parentNoteId; every branch must belong to it.\n' +
        '- "unlink": remove one branch. If it is the note\'s last branch, the note itself is deleted.\n' +
        'Branch IDs come from get_note (parentBranchIds/childBranchIds) or get_note_tree (childBranchIds, ' +
        'children[].branchId). move and clone return the url of the note at its new location.',
      organizeNoteSchema,
      {
        title: 'Organize notes',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      }
    ),
  ];
}

export async function handleOrganizationTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<ToolHandlerResult> {
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
        try {
          await client.deleteBranch(removed.branchId);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Move partially failed: note '${noteId}' was placed under '${newBranch.parentNoteId}' ` +
              `(branch '${newBranch.branchId}') but removing the old placement under ` +
              `'${removed.parentNoteId}' (branch '${removed.branchId}') failed: ${reason}. The note is ` +
              `now in both places. Finish with organize_note {action:"unlink", branchId:"${removed.branchId}"}.`,
            { cause: error }
          );
        }
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

      // Validate every branch before touching any, so a wrong ID cannot leave a
      // half-applied ordering under some other parent.
      const branches = await Promise.all(notePositions.map((p) => client.getBranch(p.branchId)));
      const foreign = branches.filter((b) => b.parentNoteId !== parentNoteId);
      if (foreign.length > 0) {
        throw new Error(
          `Branches not under parentNoteId '${parentNoteId}': ` +
            foreign.map((b) => `${b.branchId} (parent '${b.parentNoteId}')`).join(', ') +
            `. Use childBranchIds of '${parentNoteId}' from get_note or get_note_tree.`
        );
      }

      const results = [];
      for (const pos of notePositions) {
        try {
          const updated = await client.updateBranch(pos.branchId, {
            notePosition: pos.notePosition,
          });
          results.push(updated);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const done = results.map((b) => b.branchId);
          if (done.length > 0) {
            // Best effort: push the positions that did apply to open clients.
            try {
              await client.refreshNoteOrdering(parentNoteId);
            } catch {
              // The reorder error below is what matters.
            }
          }
          throw new Error(
            `Reorder failed at branch '${pos.branchId}': ${reason}. ` +
              (done.length > 0
                ? `Already updated: ${done.join(', ')}. `
                : 'No branches were updated. ') +
              'Retry with the remaining branches.',
            { cause: error }
          );
        }
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
