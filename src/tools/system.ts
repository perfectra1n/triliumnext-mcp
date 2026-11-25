import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { TriliumClientError, TriliumResponseTooLargeError } from '../client/trilium.js';
import { defineTool, type ToolHandlerResult } from './schemas.js';
import { backupNameSchema, entityIdSchema, required } from './validators.js';
import { formatMegabytes } from './contentLimits.js';

/** Default largest export ZIP returned inline; beyond this the response would swamp the client. */
export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;

let maxExportBytes = MAX_EXPORT_BYTES;

/** Process-wide system-tool limits (TRILIUM_MAX_EXPORT_BYTES). Call before registering tools. */
export function configureSystemTools(options: { maxExportBytes?: number }): void {
  maxExportBytes = options.maxExportBytes ?? MAX_EXPORT_BYTES;
}

/** ETAPI GET /notes/{id}/export formats (etapi.openapi.yaml). */
const EXPORT_FORMATS = ['html', 'markdown', 'share'] as const;

const createRevisionSchema = z.object({
  noteId: entityIdSchema.describe('ID of the note to snapshot.'),
});

const manageSystemSchema = z
  .object({
    action: z
      .enum(['backup', 'export', 'import', 'app_info', 'metrics'])
      .describe('System action to perform; see the tool description for each action.'),
    backupName: backupNameSchema
      .optional()
      .describe(
        'action="backup": backup file identifier (letters, digits, - and _); writes backup-<name>.db.'
      ),
    noteId: entityIdSchema
      .optional()
      .describe(
        'action="export": root of the subtree to export. action="import": parent note to import under.'
      ),
    format: z
      .enum(EXPORT_FORMATS, {
        message: `Invalid export format. Allowed values: ${EXPORT_FORMATS.join(', ')}`,
      })
      .default('html')
      .describe(
        'action="export": "html" (default), "markdown", or "share" (static HTML site layout).'
      ),
    data: z
      .string()
      .regex(/^[A-Za-z0-9+/=\s]+$/, 'data must be base64-encoded')
      .optional()
      .describe(
        'action="import": the ZIP archive, base64-encoded. Only practical for small archives.'
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
      "Snapshot a note's current content as a revision so later edits can be undone. List and read " +
        'revisions with get_revisions; roll back with restore_revision.',
      createRevisionSchema,
      {
        title: 'Create revision snapshot',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      }
    ),
    defineTool(
      'manage_system',
      'Trilium system operations, selected by "action":\n' +
        '- "app_info" (read-only): Trilium app/database/clipper versions.\n' +
        '- "metrics" (read-only): note, attachment, revision, branch and attribute counts and per-type ' +
        'breakdowns. Needs a Trilium version with /etapi/metrics.\n' +
        '- "backup": write backup-<backupName>.db to Trilium\'s data directory, replacing a backup with ' +
        'the same name.\n' +
        '- "export": export a subtree as a ZIP (html, markdown or share format), returned as an embedded ' +
        `resource for the user to save (max ${formatMegabytes(maxExportBytes)}). You cannot read the ZIP ` +
        'contents — to read notes use get_note.\n' +
        '- "import": import a base64 ZIP (e.g. a previous export) under noteId; returns the created note.',
      manageSystemSchema,
      {
        title: 'Backup, export, import, app info, or metrics',
        readOnlyHint: false,
        // backup overwrites a same-named file; import writes new notes.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      }
    ),
  ];
}

export async function handleSystemTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<ToolHandlerResult> {
  switch (name) {
    case 'create_revision': {
      const parsed = createRevisionSchema.parse(args);
      await client.createRevision(parsed.noteId);
      const url = await client.getNoteUrl(parsed.noteId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                noteId: parsed.noteId,
                note: 'Revision created. List it with get_revisions {noteId}.',
                url,
              },
              null,
              2
            ),
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

      if (parsed.action === 'metrics') {
        let metrics;
        try {
          metrics = await client.getMetrics();
        } catch (error) {
          if (error instanceof TriliumClientError && error.status === 404) {
            throw new TriliumClientError(
              404,
              'METRICS_UNSUPPORTED',
              'This Trilium version has no /etapi/metrics endpoint. Upgrade Trilium, or use ' +
                'manage_system {action:"app_info"} for version info.'
            );
          }
          throw error;
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(metrics, null, 2) }],
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
      // The client's signature predates the spec's "share" format; the query
      // value is forwarded verbatim.
      const exportTooLarge = (sizeBytes: number, atLeast: boolean): TriliumClientError =>
        new TriliumClientError(
          413,
          'EXPORT_TOO_LARGE',
          `Export of '${noteId}' is ${atLeast ? 'at least ' : ''}${sizeBytes} bytes, over the ` +
            `${maxExportBytes}-byte limit for inline export. Export a smaller subtree (a child note), ` +
            'or have the user export from the Trilium UI.'
        );
      // The cap is enforced while downloading, so an oversized ZIP is never
      // buffered (let alone base64-encoded) in full.
      let data: Buffer;
      try {
        data = await client.exportNote(noteId, format as 'html' | 'markdown', maxExportBytes);
      } catch (error) {
        if (error instanceof TriliumResponseTooLargeError) {
          throw exportTooLarge(error.sizeBytes, true);
        }
        throw error;
      }
      if (data.byteLength > maxExportBytes) {
        throw exportTooLarge(data.byteLength, false);
      }

      const blob = data.toString('base64');
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
                note:
                  'The ZIP is attached as an embedded resource for the user to save; its contents are ' +
                  'not readable here. Use get_note to read notes.',
              },
              null,
              2
            ),
          },
          {
            type: 'resource',
            resource: {
              uri: `trilium://export/${noteId}.${format}.zip`,
              mimeType: 'application/zip',
              blob,
            },
          },
        ],
      };
    }

    default:
      return null;
  }
}
