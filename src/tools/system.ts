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
  format: exportFormatSchema
    .default('html')
    .describe(
      'Format hint forwarded to the ETAPI revision endpoint (default: html). The revision always ' +
        "snapshots the note's current stored content."
    ),
});

const manageSystemSchema = z
  .object({
    action: z
      .enum(['backup', 'export', 'import', 'app_info'])
      .describe(
        'System action to perform. ' +
          '"backup" — create a full database backup (fields: backupName). ' +
          '"export" — export a note and its subtree as a ZIP archive, returned base64-encoded (fields: noteId, format?). ' +
          '"import" — import a ZIP archive (e.g. from a previous export) under a parent note (fields: noteId, data). ' +
          '"app_info" — return Trilium instance info (version, database version) for diagnostics (no fields).'
      ),
    backupName: backupNameSchema
      .optional()
      .describe(
        'Required for action="backup": identifier for the backup file (alphanumeric, hyphens, underscores).'
      ),
    noteId: z
      .string()
      .optional()
      .describe(
        'Required for action="export": note to export (use "root" to export the entire database). ' +
          'Required for action="import": parent note to import the ZIP under.'
      ),
    format: exportFormatSchema
      .default('html')
      .describe(
        'Optional for action="export": markdown is recommended for LLM processing (default: html).'
      ),
    data: z
      .string()
      .regex(/^[A-Za-z0-9+/=\s]+$/, 'data must be base64-encoded')
      .optional()
      .describe(
        'Required for action="import": the ZIP archive as base64. Intended for small archives — ' +
          'base64 you can emit inline is the practical size limit.'
      ),
  })
  .check((ctx) => {
    const { action, backupName, noteId, data } = ctx.value;
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
    } else if (action === 'import') {
      if (!noteId) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'action="import" requires "noteId" (the parent note to import under)',
          path: ['noteId'],
        });
      }
      if (!data) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'action="import" requires "data" (base64-encoded ZIP archive)',
          path: ['data'],
        });
      }
    }
  });

export function registerSystemTools(): Tool[] {
  return [
    defineTool(
      'create_revision',
      'Create a revision (snapshot) of a note. Useful before making significant edits to preserve the current state. ' +
        'Revisions can be viewed and restored in Trilium. To read revisions later, use get_revisions. ' +
        'The response includes a URL that opens the note in Trilium — give it to the user when you are done.',
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
      'Trilium system operations. Four actions via "action":\n' +
        '- "backup": create a full database backup file (backup-{backupName}.db) in Trilium\'s data directory. ' +
        'Use before major operations for safety.\n' +
        '- "export": export a note and its subtree as a ZIP archive, returned base64-encoded. ' +
        'Use "root" as noteId to export the entire database. Format "markdown" is recommended for LLM processing.\n' +
        '- "import": import a ZIP archive (typically from a previous export) under a parent note. ' +
        'Pass the archive base64-encoded in "data". Returns the created note. Intended for small archives.\n' +
        '- "app_info": return Trilium instance info (app version, database version, clipper protocol version) — ' +
        'useful for diagnostics and version-dependent behavior.',
      manageSystemSchema,
      {
        title: 'Backup, export, import, or app info',
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
      const url = await client.getNoteUrl(parsed.noteId);
      return {
        content: [
          {
            type: 'text',
            text:
              `Revision created for note ${parsed.noteId}. The revision is now available in Trilium's note history. ` +
              `View the note: ${url}`,
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

      if (parsed.action === 'app_info') {
        const info = await client.getAppInfo();
        return {
          content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
        };
      }

      if (parsed.action === 'import') {
        const noteId = required(parsed.noteId, 'noteId');
        const data = required(parsed.data, 'data');
        const zipBuffer = Buffer.from(data.replace(/\s/g, ''), 'base64');
        const result = await client.importZip(noteId, zipBuffer);
        const url = await client.getNoteUrl(result.note.noteId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'import',
                  parentNoteId: noteId,
                  note: result.note,
                  branch: result.branch,
                  url,
                },
                null,
                2
              ),
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
