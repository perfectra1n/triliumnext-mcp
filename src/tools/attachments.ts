import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TriliumResponseTooLargeError, type TriliumClient } from '../client/trilium.js';
import type { Attachment } from '../types/etapi.js';
import { defineTool, type ToolHandlerResult } from './schemas.js';
import { entityIdSchema, positionSchema, required } from './validators.js';
import { searchReplaceBlockSchema, resolveContent, verifySearchReplaceResults } from './diff.js';
import { base64DecodedLength, capWithNotice, formatMegabytes } from './contentLimits.js';
import {
  IMAGE_MIME_TYPES,
  isImageMimeType,
  isBinaryMimeType,
  parseDataUrl,
  resolveContentInput,
  ContentNormalizationError,
  CONTENT_SOURCE_GUIDANCE,
} from './contentInput.js';

// The MIME helpers moved to contentInput.ts (which this module depends on);
// re-export them so existing importers keep working.
export { IMAGE_MIME_TYPES, isImageMimeType, isBinaryMimeType, parseDataUrl };

// ============================================================================
// Shared upload helper
// ============================================================================

/**
 * A binary attachment's record was created but its content upload failed,
 * and the empty attachment could not be deleted either. Carries the ID so the
 * caller can tell the user (or the model) what was left behind.
 */
export class OrphanedAttachmentError extends Error {
  constructor(
    public readonly attachmentId: string,
    uploadError: unknown,
    deleteError: unknown
  ) {
    super(
      `uploading the content failed (${errorText(uploadError)}), and the empty attachment ` +
        `${attachmentId} it left behind could not be deleted (${errorText(deleteError)}). ` +
        `Delete it with delete_attachment {attachmentId:"${attachmentId}"} or retry with ` +
        `write_attachment {attachmentId:"${attachmentId}", mode:"replace"}.`
    );
    this.name = 'OrphanedAttachmentError';
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Create an attachment with its content. Binary content needs two requests
 * (create with an empty body, then upload the bytes); if the upload fails the
 * empty attachment is deleted again (best effort) so a retry does not leave a
 * duplicate behind. When that delete also fails, an
 * {@link OrphanedAttachmentError} names the leftover attachment.
 */
export async function createAttachmentWithContent(
  client: TriliumClient,
  def: {
    ownerId: string;
    role: string;
    mime: string;
    title: string;
    position?: number;
    isBinary: boolean;
    buffer: Buffer;
  }
): Promise<Attachment> {
  const attachment = await client.createAttachment({
    ownerId: def.ownerId,
    role: def.role,
    mime: def.mime,
    title: def.title,
    content: def.isBinary ? '' : def.buffer.toString('utf8'),
    ...(def.position !== undefined ? { position: def.position } : {}),
  });
  if (!def.isBinary) return attachment;
  try {
    await client.updateAttachmentContentBinary(attachment.attachmentId, def.buffer);
  } catch (uploadError) {
    try {
      await client.deleteAttachment(attachment.attachmentId);
    } catch (deleteError) {
      throw new OrphanedAttachmentError(attachment.attachmentId, uploadError, deleteError);
    }
    throw uploadError;
  }
  return attachment;
}

// ============================================================================
// Schemas
// ============================================================================

/**
 * Default cap on attachment bytes get_attachment inlines — image blocks and
 * base64 embedded resources alike (TRILIUM_MAX_INLINE_ATTACHMENT_BYTES).
 */
export const BINARY_RESOURCE_MAX_BYTES = 5 * 1024 * 1024;

let maxInlineAttachmentBytes = BINARY_RESOURCE_MAX_BYTES;

/** Process-wide attachment-tool limits. Call before registering tools. */
export function configureAttachmentTools(options: { maxInlineAttachmentBytes?: number }): void {
  maxInlineAttachmentBytes = options.maxInlineAttachmentBytes ?? BINARY_RESOURCE_MAX_BYTES;
}

const ROLE_GUIDANCE =
  '"image" for pictures embedded in the note, "file" for downloadable files (Trilium accepts other ' +
  'values, but these are the two in normal use).';

const createAttachmentSchema = z.object({
  ownerId: entityIdSchema.describe('ID of the note that will own this attachment'),
  role: z.string().min(1, 'Role is required').describe(ROLE_GUIDANCE),
  mime: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional MIME type (e.g., "image/png", "application/pdf") — auto-detected from a data URL, ' +
        'magic bytes, or file extension. Set only to override detection.'
    ),
  title: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Title/filename of the attachment. Optional when content is a file path or URL ' +
        '(defaults to its basename); required for inline content.'
    ),
  content: z.string().describe(`Content of the attachment. ${CONTENT_SOURCE_GUIDANCE}`),
  position: positionSchema.optional().describe('Position for ordering (10, 20, 30...)'),
});

const getAttachmentSchema = z
  .object({
    attachmentId: entityIdSchema
      .optional()
      .describe('Fetch this one attachment (body included unless include_content=false).'),
    noteId: entityIdSchema
      .optional()
      .describe(
        "List this note's attachments (metadata only: attachmentId, title, mime, contentLength)."
      ),
    include_content: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'With attachmentId: include the body (default true). Pass false to check mime/size first.'
      ),
  })
  .check((ctx) => {
    const { attachmentId, noteId } = ctx.value;
    const provided = [attachmentId !== undefined, noteId !== undefined].filter(Boolean).length;
    if (provided === 0) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Exactly one of "attachmentId" or "noteId" is required',
        path: [],
      });
    } else if (provided > 1) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Provide either "attachmentId" or "noteId", not both',
        path: [],
      });
    }
  });

const writeAttachmentSchema = z
  .object({
    attachmentId: entityIdSchema.describe('ID of the attachment to write to'),
    mode: z
      .enum(['metadata', 'replace', 'edit'])
      .describe(
        'Write mode. ' +
          '"metadata" — update role/mime/title/position only. ' +
          '"replace" — overwrite attachment content (accepts a file path, http(s) URL, data URL, base64, or raw text). ' +
          '"edit" — apply search/replace blocks (changes) or a unified diff (patch) to text content.'
      ),
    role: z.string().optional().describe(`New role (metadata mode only): ${ROLE_GUIDANCE}`),
    mime: z.string().optional().describe('New MIME type (metadata mode only).'),
    title: z.string().optional().describe('New title/filename (metadata mode only).'),
    position: positionSchema.optional().describe('New position for ordering (metadata mode only).'),
    content: z
      .string()
      .optional()
      .describe(
        'New content for "replace" mode, in any form create_attachment content accepts (URL, data ' +
          'URL, base64, raw text, or a server-side file path when permitted).'
      ),
    changes: z
      .array(searchReplaceBlockSchema)
      .optional()
      .describe(
        '"edit" mode: {old_string, new_string} blocks applied in order; each old_string must match the ' +
          'stored text exactly once ("" inserts at the start).'
      ),
    patch: z
      .string()
      .optional()
      .describe('"edit" mode: single-file unified diff (with @@ hunks) against the stored text.'),
  })
  .check((ctx) => {
    const { mode, role, mime, title, position, content, changes, patch } = ctx.value;
    if (mode === 'metadata') {
      const hasMeta =
        role !== undefined || mime !== undefined || title !== undefined || position !== undefined;
      if (!hasMeta) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message:
            'mode="metadata" requires at least one of "role", "mime", "title", or "position"',
          path: [],
        });
      }
      if (content !== undefined || changes !== undefined || patch !== undefined) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'mode="metadata" cannot include content/changes/patch',
          path: [],
        });
      }
    } else if (mode === 'replace') {
      if (content === undefined) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'mode="replace" requires "content"',
          path: ['content'],
        });
      }
      if (changes !== undefined || patch !== undefined) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'mode="replace" cannot include "changes" or "patch" (use mode="edit")',
          path: [],
        });
      }
    } else if (mode === 'edit') {
      const diffModes = [changes !== undefined, patch !== undefined].filter(Boolean).length;
      if (diffModes !== 1) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'mode="edit" requires exactly one of "changes" or "patch"',
          path: [],
        });
      }
      if (content !== undefined) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'mode="edit" cannot include "content" (use mode="replace" instead)',
          path: ['content'],
        });
      }
    }
  });

const deleteAttachmentSchema = z.object({
  attachmentId: entityIdSchema.describe('ID of the attachment to delete'),
});

// ============================================================================
// Registration
// ============================================================================

export function registerAttachmentTools(): Tool[] {
  return [
    defineTool(
      'get_attachment',
      "Read one attachment (attachmentId) or list a note's attachments (noteId, metadata only). " +
        'Bodies come back by type: images as image blocks, text as a string (long text is truncated), ' +
        'other binaries as a base64 embedded resource. Images and binaries over ' +
        `${formatMegabytes(maxInlineAttachmentBytes)} return metadata only.`,
      getAttachmentSchema,
      { title: 'Read attachment(s)', readOnlyHint: true, openWorldHint: false }
    ),
    defineTool(
      'create_attachment',
      'Attach content to a note and return the attachment metadata. mime and title are auto-detected ' +
        'from the source (a path or URL basename becomes the title); inline base64/text needs a title. ' +
        'Example: {ownerId, role: "image", title: "dot.png", content: "data:image/png;base64,iVBORw0..."}.',
      createAttachmentSchema,
      {
        title: 'Create attachment',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      }
    ),
    defineTool(
      'write_attachment',
      'Update an attachment: mode="metadata" changes role/mime/title/position; "replace" overwrites ' +
        'the body (path, URL, data URL, base64 or text; the stored mime is kept); "edit" applies ' +
        '"changes" or a "patch" to a text attachment (binary attachments must use "replace").',
      writeAttachmentSchema,
      {
        title: 'Write attachment',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      }
    ),
    defineTool(
      'delete_attachment',
      'Permanently delete an attachment and its content.',
      deleteAttachmentSchema,
      {
        title: 'Delete attachment',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      }
    ),
  ];
}

// ============================================================================
// Dispatch
// ============================================================================

function tooLarge(attachment: Attachment, sizeBytes: number, atLeast = false): ToolHandlerResult {
  const kind = isImageMimeType(attachment.mime) ? 'image' : 'binary';
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ...attachment,
            notice:
              `Content not returned: this ${kind} attachment is ${atLeast ? 'at least ' : ''}${sizeBytes} ` +
              `bytes, over the ${maxInlineAttachmentBytes}-byte limit, so it is too large to inline here. ` +
              'Do not retry; have the user open it in Trilium instead.',
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleAttachmentTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<ToolHandlerResult> {
  switch (name) {
    case 'create_attachment': {
      const parsed = createAttachmentSchema.parse(args);
      const resolved = await resolveContentInput(parsed.content, {
        mime: parsed.mime,
        filename: parsed.title,
      });
      const title = parsed.title ?? resolved.sourceName;
      if (!title) {
        throw new ContentNormalizationError(
          'TITLE_REQUIRED',
          'A title is required when the content source has no filename (inline base64 or raw text).',
          'Provide a title (e.g. "screenshot.png"), or pass a file path or URL whose basename can serve as one.'
        );
      }
      let result: Attachment;
      try {
        result = await createAttachmentWithContent(client, {
          ownerId: parsed.ownerId,
          role: parsed.role,
          mime: resolved.mime,
          title,
          position: parsed.position,
          isBinary: resolved.isBinary,
          buffer: resolved.buffer,
        });
      } catch (error) {
        if (error instanceof OrphanedAttachmentError) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: `The attachment was created, but ${error.message}`,
                    attachmentId: error.attachmentId,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        throw error;
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'get_attachment': {
      const parsed = getAttachmentSchema.parse(args);

      if (parsed.noteId) {
        const attachments = await client.getNoteAttachments(parsed.noteId);
        return {
          content: [{ type: 'text', text: JSON.stringify(attachments, null, 2) }],
        };
      }

      const attachmentId = required(parsed.attachmentId, 'attachmentId');
      const attachment = await client.getAttachment(attachmentId);
      if (!parsed.include_content) {
        return {
          content: [{ type: 'text', text: JSON.stringify(attachment, null, 2) }],
        };
      }

      const isImage = isImageMimeType(attachment.mime);
      if (isImage || isBinaryMimeType(attachment.mime)) {
        // Images and binaries are inlined as base64 (a ~1.33x copy on top of
        // the bytes), so both are capped: first on the declared size, without
        // fetching anything, then on the bytes actually received — the client
        // stops reading once the cap is passed, so an oversized blob is never
        // buffered whole.
        const maxBytes = maxInlineAttachmentBytes;
        if ((attachment.contentLength ?? 0) > maxBytes) {
          return tooLarge(attachment, attachment.contentLength);
        }
        let encoded: string;
        try {
          // Attachments created through ETAPI with a base64 string body are
          // stored as that text; this returns those as-is instead of encoding
          // them a second time (the cap still bounds the stored bytes).
          encoded = await client.getAttachmentContentAsBase64(attachmentId, maxBytes);
        } catch (error) {
          if (error instanceof TriliumResponseTooLargeError) {
            return tooLarge(attachment, error.sizeBytes, true);
          }
          throw error;
        }
        // contentLength can be absent or stale; re-check what actually came back.
        const actualBytes = base64DecodedLength(encoded);
        if (actualBytes > maxBytes) {
          return tooLarge(attachment, actualBytes);
        }
        if (isImage) {
          return { content: [{ type: 'image', data: encoded, mimeType: attachment.mime }] };
        }
        return {
          content: [
            {
              type: 'resource',
              resource: {
                uri: `trilium://attachment/${encodeURIComponent(attachmentId)}`,
                mimeType: attachment.mime,
                blob: encoded,
              },
            },
          ],
        };
      }

      const content = await client.getAttachmentContent(attachmentId);
      const capped = capWithNotice(
        content,
        'attachment',
        'Use write_attachment edit mode with targeted search/replace blocks to modify it without reading the whole body.'
      );
      return {
        content: [{ type: 'text', text: capped }],
      };
    }

    case 'write_attachment': {
      const parsed = writeAttachmentSchema.parse(args);

      if (parsed.mode === 'metadata') {
        const patch: { role?: string; mime?: string; title?: string; position?: number } = {};
        if (parsed.role !== undefined) patch.role = parsed.role;
        if (parsed.mime !== undefined) patch.mime = parsed.mime;
        if (parsed.title !== undefined) patch.title = parsed.title;
        if (parsed.position !== undefined) patch.position = parsed.position;
        const result = await client.updateAttachment(parsed.attachmentId, patch);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      if (parsed.mode === 'replace') {
        const content = required(parsed.content, 'content');
        const attachment = await client.getAttachment(parsed.attachmentId);
        // The stored mime is the hint: replace never silently re-types the
        // attachment (metadata mode does that).
        const resolved = await resolveContentInput(content, {
          mime: attachment.mime,
          filename: attachment.title,
        });
        if (isBinaryMimeType(attachment.mime)) {
          await client.updateAttachmentContentBinary(parsed.attachmentId, resolved.buffer);
        } else {
          await client.updateAttachmentContent(
            parsed.attachmentId,
            resolved.buffer.toString('utf8')
          );
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { success: true, attachmentId: parsed.attachmentId, mode: 'replace' },
                null,
                2
              ),
            },
          ],
        };
      }

      // edit
      const target = await client.getAttachment(parsed.attachmentId);
      if (isBinaryMimeType(target.mime)) {
        throw new Error(
          `Attachment ${parsed.attachmentId} is binary (${target.mime}); mode="edit" only works on text ` +
            'attachments. Use mode="replace" with a file path, URL, data URL or base64.'
        );
      }
      const existing = await client.getAttachmentContent(parsed.attachmentId);
      const finalContent = await resolveContent(existing, {
        changes: parsed.changes,
        patch: parsed.patch,
      });
      await client.updateAttachmentContent(parsed.attachmentId, finalContent);

      if (parsed.changes !== undefined) {
        const readBack = await client.getAttachmentContent(parsed.attachmentId);
        verifySearchReplaceResults(readBack, parsed.changes, finalContent);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: true, attachmentId: parsed.attachmentId, mode: 'edit' },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'delete_attachment': {
      const parsed = deleteAttachmentSchema.parse(args);
      await client.deleteAttachment(parsed.attachmentId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, attachmentId: parsed.attachmentId }, null, 2),
          },
        ],
      };
    }

    default:
      return null;
  }
}
