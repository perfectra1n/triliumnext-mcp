import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { positionSchema } from './validators.js';

const moveNoteSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to move'),
  newParentNoteId: z
    .string()
    .min(1, 'New parent note ID is required')
    .describe('ID of the new parent note'),
  prefix: z.string().optional().describe('Optional prefix for the note in its new location'),
});

const cloneNoteSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to clone'),
  parentNoteId: z
    .string()
    .min(1, 'Parent note ID is required')
    .describe('ID of the parent note for the clone'),
  prefix: z.string().optional().describe('Optional prefix for the cloned note'),
});

const reorderNotesSchema = z.object({
  parentNoteId: z.string().min(1, 'Parent note ID is required').describe('ID of the parent note'),
  notePositions: z
    .array(
      z.object({
        branchId: z
          .string()
          .min(1, 'Branch ID is required')
          .describe('ID of the branch to reorder'),
        notePosition: positionSchema.describe('New position (10, 20, 30...)'),
      })
    )
    .describe('Array of branch positions to update'),
});

const deleteBranchSchema = z.object({
  branchId: z
    .string()
    .min(1, 'Branch ID is required')
    .describe('ID of the branch to delete (not the note ID)'),
});

export function registerOrganizationTools(): Tool[] {
  return [
    defineTool(
      'move_note',
      'Move a note to a different parent. This deletes the old branch and creates a new one under the target parent.',
      moveNoteSchema
    ),
    defineTool(
      'clone_note',
      'Clone a note to appear in multiple locations. Creates a new branch pointing to the same note.',
      cloneNoteSchema
    ),
    defineTool(
      'reorder_notes',
      'Change the order of notes within a parent. Update notePosition on branches to control display order.',
      reorderNotesSchema
    ),
    defineTool(
      'delete_branch',
      'Delete a specific branch (parent-child link) without deleting the note itself. Use this to remove a note from one location while keeping it in others. WARNING: If you delete the last branch of a note, the note itself will be deleted.',
      deleteBranchSchema
    ),
  ];
}

export async function handleOrganizationTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
  switch (name) {
    case 'move_note': {
      const parsed = moveNoteSchema.parse(args);

      // Get the note to find its current branch
      const note = await client.getNote(parsed.noteId);

      // Create a new branch under the new parent FIRST
      // (If we delete the old branch first, the note would be deleted when last branch is removed)
      const newBranch = await client.createBranch({
        noteId: parsed.noteId,
        parentNoteId: parsed.newParentNoteId,
        prefix: parsed.prefix,
      });

      // Delete the first branch (primary location)
      if (note.parentBranchIds.length > 0) {
        await client.deleteBranch(note.parentBranchIds[0]);
      }

      return {
        content: [
          { type: 'text', text: JSON.stringify({ success: true, branch: newBranch }, null, 2) },
        ],
      };
    }

    case 'clone_note': {
      const parsed = cloneNoteSchema.parse(args);

      // Create a new branch pointing to the same note
      const branch = await client.createBranch({
        noteId: parsed.noteId,
        parentNoteId: parsed.parentNoteId,
        prefix: parsed.prefix,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(branch, null, 2) }],
      };
    }

    case 'reorder_notes': {
      const parsed = reorderNotesSchema.parse(args);

      // Update each branch position
      const results = [];
      for (const pos of parsed.notePositions) {
        const updated = await client.updateBranch(pos.branchId, {
          notePosition: pos.notePosition,
        });
        results.push(updated);
      }

      // Refresh the note ordering
      await client.refreshNoteOrdering(parsed.parentNoteId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, updatedBranches: results }, null, 2),
          },
        ],
      };
    }

    case 'delete_branch': {
      const parsed = deleteBranchSchema.parse(args);
      await client.deleteBranch(parsed.branchId);
      return {
        content: [{ type: 'text', text: `Branch ${parsed.branchId} deleted successfully` }],
      };
    }

    default:
      return null;
  }
}
