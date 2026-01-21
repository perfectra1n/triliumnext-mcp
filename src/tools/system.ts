import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';

const createRevisionSchema = z.object({
  noteId: z.string().describe('ID of the note to create a revision for'),
  format: z.enum(['html', 'markdown']).optional().describe('Format of the revision content'),
});

const createBackupSchema = z.object({
  backupName: z.string().describe('Name for the backup file (will create backup-{name}.db)'),
});

const exportNoteSchema = z.object({
  noteId: z.string().describe('ID of the note to export (use "root" for entire database)'),
  format: z.enum(['html', 'markdown']).optional().describe('Export format'),
});

export function registerSystemTools(): Tool[] {
  return [
    {
      name: 'create_revision',
      description: 'Create a revision (snapshot) of a note. Useful before making significant edits to preserve the current state. Revisions can be viewed and restored in Trilium.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'ID of the note to create a revision for' },
          format: {
            type: 'string',
            enum: ['html', 'markdown'],
            description: 'Format of the revision content (default: html)',
          },
        },
        required: ['noteId'],
      },
    },
    {
      name: 'create_backup',
      description: 'Create a full database backup. The backup file will be named backup-{backupName}.db and stored in the Trilium data directory. Use before major operations for safety.',
      inputSchema: {
        type: 'object',
        properties: {
          backupName: {
            type: 'string',
            description: 'Name for the backup (e.g., "before-migration", "daily-2024-01-15")',
          },
        },
        required: ['backupName'],
      },
    },
    {
      name: 'export_note',
      description: 'Export a note and its subtree as a ZIP file. Returns the export as base64-encoded data. Use format=markdown for LLM-friendly output.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: {
            type: 'string',
            description: 'ID of the note to export (use "root" to export entire database)',
          },
          format: {
            type: 'string',
            enum: ['html', 'markdown'],
            description: 'Export format - markdown is recommended for LLM processing (default: html)',
          },
        },
        required: ['noteId'],
      },
    },
  ];
}

export async function handleSystemTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
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

    case 'create_backup': {
      const parsed = createBackupSchema.parse(args);
      await client.createBackup(parsed.backupName);
      return {
        content: [
          {
            type: 'text',
            text: `Backup created: backup-${parsed.backupName}.db. The backup is stored in Trilium's data directory.`,
          },
        ],
      };
    }

    case 'export_note': {
      const parsed = exportNoteSchema.parse(args);
      const format = parsed.format ?? 'html';
      const data = await client.exportNote(parsed.noteId, format);

      // Convert ArrayBuffer to base64
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
                noteId: parsed.noteId,
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
