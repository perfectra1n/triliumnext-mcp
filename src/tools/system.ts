import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { exportFormatSchema, backupNameSchema, required } from './validators.js';

const createRevisionSchema = z.object({
  noteId: z
    .string()
    .min(1, 'Note ID is required')
    .describe('ID of the note to create a revision for'),
  format: exportFormatSchema.optional().describe('Format of the revision content (default: html)'),
});

const manageSystemSchema = z
  .object({
    action: z
      .enum(['backup', 'export'])
      .describe(
        'System action to perform. ' +
          '"backup" — create a full database backup (fields: backupName). ' +
          '"export" — export a note and its subtree as a ZIP archive, returned base64-encoded (fields: noteId, format?).'
      ),
    backupName: backupNameSchema
      .optional()
      .describe('Required for action="backup": identifier for the backup file (alphanumeric, hyphens, underscores).'),
    noteId: z
      .string()
      .optional()
      .describe('Required for action="export": note to export (use "root" to export the entire database).'),
    format: exportFormatSchema
      .optional()
      .describe('Optional for action="export": markdown is recommended for LLM processing (default: html).'),
  })
  .check((ctx) => {
    const { action, backupName, noteId } = ctx.value;
    if (action === 'backup') {
      if (!backupName) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'action="backup" requires "backupName"',
          path: ['backupName'],
        });
      }
    } else if (action === 'export') {
      if (!noteId) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'action="export" requires "noteId"',
          path: ['noteId'],
        });
      }
    }
  });

export function registerSystemTools(): Tool[] {
  return [
    defineTool(
      'create_revision',
      'Create a revision (snapshot) of a note. Useful before making significant edits to preserve the current state. ' +
        'Revisions can be viewed and restored in Trilium. To read revisions later, use get_revisions.',
      createRevisionSchema,
      {
        title: 'Create revision snapshot',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      }
    ),
    defineTool(
      'manage_system',
      'Trilium system operations. Two actions via "action":\n' +
        '- "backup": create a full database backup file (backup-{backupName}.db) in Trilium\'s data directory. ' +
        'Use before major operations for safety.\n' +
        '- "export": export a note and its subtree as a ZIP archive, returned base64-encoded. ' +
        'Use "root" as noteId to export the entire database. Format "markdown" is recommended for LLM processing.',
      manageSystemSchema,
      {
        title: 'Backup or export',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      }
    ),
  ];
}

export async function handleSystemTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
  switch (name) {
    case 'create_revision': {
      const parsed = createRevisionSchema.parse(args);
      await client.createRevision(parsed.noteId, parsed.format ?? 'html');
      return {
        content: [
          {
            type: 'text',
            text: `Revision created for note ${parsed.noteId}. The revision is now available in Trilium's note history.`,
          },
        ],
      };
    }

    case 'manage_system': {
      const parsed = manageSystemSchema.parse(args);

      if (parsed.action === 'backup') {
        const backupName = required(parsed.backupName, 'backupName');
        await client.createBackup(backupName);
        return {
          content: [
            {
              type: 'text',
              text: `Backup created: backup-${backupName}.db. The backup is stored in Trilium's data directory.`,
            },
          ],
        };
      }

      // export
      const noteId = required(parsed.noteId, 'noteId');
      const format = parsed.format ?? 'html';
      const data = await client.exportNote(noteId, format);

      const bytes = new Uint8Array(data);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                action: 'export',
                noteId,
                format,
                sizeBytes: data.byteLength,
                base64Data: base64,
                note: 'This is a ZIP file encoded as base64. Decode and extract to access the exported notes.',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    default:
      return null;
  }
}
