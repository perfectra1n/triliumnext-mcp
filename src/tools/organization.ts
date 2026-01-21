import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';

const moveNoteSchema = z.object({
  noteId: z.string().describe('ID of the note to move'),
  newParentNoteId: z.string().describe('ID of the new parent note'),
  prefix: z.string().optional().describe('Optional prefix for the note in its new location'),
});

const cloneNoteSchema = z.object({
  noteId: z.string().describe('ID of the note to clone'),
  parentNoteId: z.string().describe('ID of the parent note for the clone'),
  prefix: z.string().optional().describe('Optional prefix for the cloned note'),
});

const reorderNotesSchema = z.object({
  parentNoteId: z.string().describe('ID of the parent note'),
  notePositions: z.array(z.object({
    branchId: z.string().describe('ID of the branch to reorder'),
    notePosition: z.number().describe('New position (10, 20, 30...)'),
  })).describe('Array of branch positions'),
});

export function registerOrganizationTools(): Tool[] {
  return [
    {
      name: 'move_note',
      description: 'Move a note to a different parent. This deletes the old branch and creates a new one under the target parent.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'ID of the note to move' },
          newParentNoteId: { type: 'string', description: 'ID of the new parent note' },
          prefix: { type: 'string', description: 'Optional prefix for the note in its new location' },
        },
        required: ['noteId', 'newParentNoteId'],
      },
    },
    {
      name: 'clone_note',
      description: 'Clone a note to appear in multiple locations. Creates a new branch pointing to the same note.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'ID of the note to clone' },
          parentNoteId: { type: 'string', description: 'ID of the parent note for the clone' },
          prefix: { type: 'string', description: 'Optional prefix for the cloned note' },
        },
        required: ['noteId', 'parentNoteId'],
      },
    },
    {
      name: 'reorder_notes',
      description: 'Change the order of notes within a parent. Update notePosition on branches to control display order.',
      inputSchema: {
        type: 'object',
        properties: {
          parentNoteId: { type: 'string', description: 'ID of the parent note' },
          notePositions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                branchId: { type: 'string', description: 'ID of the branch to reorder' },
                notePosition: { type: 'number', description: 'New position (10, 20, 30...)' },
              },
              required: ['branchId', 'notePosition'],
            },
            description: 'Array of branch positions to update',
          },
        },
        required: ['parentNoteId', 'notePositions'],
      },
    },
  ];
}

export async function handleOrganizationTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  switch (name) {
    case 'move_note': {
      const parsed = moveNoteSchema.parse(args);

      // Get the note to find its current branch
      const note = await client.getNote(parsed.noteId);

      // Delete the first branch (primary location)
      if (note.parentBranchIds.length > 0) {
        await client.deleteBranch(note.parentBranchIds[0]);
      }

      // Create a new branch under the new parent
      const newBranch = await client.createBranch({
        noteId: parsed.noteId,
        parentNoteId: parsed.newParentNoteId,
        prefix: parsed.prefix,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, branch: newBranch }, null, 2) }],
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
        content: [{ type: 'text', text: JSON.stringify({ success: true, updatedBranches: results }, null, 2) }],
      };
    }

    default:
      return null;
  }
}
