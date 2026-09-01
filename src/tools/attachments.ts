import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { positionSchema, required } from './validators.js';
import { searchReplaceBlockSchema, resolveContent, verifySearchReplaceResults } from './diff.js';
import { capWithNotice } from './contentLimits.js';
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
// Schemas
// ============================================================================

const createAttachmentSchema = z.object({
  ownerId: z
    .string()
    .min(1, 'Owner note ID is required')
    .describe('ID of the note that will own this attachment'),
  role: z
    .string()
    .min(1, 'Role is required')
    .describe('Role of the attachment (e.g., "file", "image")'),
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
    attachmentId: z
      .string()
      .optional()
      .describe(
        'If provided, returns the single attachment with this ID (body included by default — pass include_content=false to skip the body).'
      ),
    noteId: z
      .string()
      .optional()
      .describe(
        'If provided, returns an array of all attachments for this note. ' +
          'This listing path is metadata-only (title, mime, size, attachmentId) — use it first when you do not yet know which attachment you want.'
      ),
    include_content: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Only meaningful with "attachmentId". Defaults to true — returns the attachment body: ' +
          'image attachments come back as MCP image blocks, text attachments as raw strings, other binary as base64-wrapped text. ' +
          'Set to false when you specifically need only metadata (e.g., to check size/mime of a potentially large binary before fetching, or for an inventory pass). ' +
          'Otherwise leave at the default — do not pre-emptively set false to "save tokens" if you actually need the content.'
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
    attachmentId: z
      .string()
      .min(1, 'Attachment ID is required')
      .describe('ID of the attachment to write to'),
    mode: z
      .enum(['metadata', 'replace', 'edit'])
      .describe(
        'Write mode. ' +
          '"metadata" — update role/mime/title/position only. ' +
          '"replace" — overwrite attachment content (accepts a file path, http(s) URL, data URL, base64, or raw text). ' +
          '"edit" — apply search/replace blocks (changes) or a unified diff (patch) to existing text content.'
      ),
    role: z.string().optional().describe('New role (metadata mode only).'),
    mime: z.string().optional().describe('New MIME type (metadata mode only).'),
    title: z.string().optional().describe('New title/filename (metadata mode only).'),
    position: positionSchema.optional().describe('New position for ordering (metadata mode only).'),
    content: z
      .string()
      .optional()
      .describe(`New content for "replace" mode. ${CONTENT_SOURCE_GUIDANCE}`),
    changes: z
      .array(searchReplaceBlockSchema)
      .optional()
      .describe(
        '"edit" mode: array of {old_string, new_string} blocks applied sequentially to existing content.'
      ),
    patch: z
      .string()
      .optional()
      .describe('"edit" mode: unified diff to apply to existing content.'),
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
  attachmentId: z
    .string()
    .min(1, 'Attachment ID is required')
    .describe('ID of the attachment to delete'),
});

// ============================================================================
// Registration
// ============================================================================

export function registerAttachmentTools(): Tool[] {
  return [
    defineTool(
      'get_attachment',
      "Read an attachment or list a note's attachments. Two modes:\n" +
        '- Pass "noteId" to list all attachments for that note (metadata only — title, mime, size, attachmentId).\n' +
        '- Pass "attachmentId" to fetch one attachment. By default this returns the body: images come back as MCP image blocks, ' +
        'text attachments as raw strings, other binary as base64-wrapped text.\n\n' +
        'This is the canonical way to read attachment content — DO NOT bypass this tool by calling the Trilium HTTP/ETAPI directly ' +
        '(e.g. via curl, fetch, or shell). If you only want metadata for a specific attachmentId (e.g. to check size before paying for a large binary), pass include_content=false.',
      getAttachmentSchema,
      { title: 'Read attachment(s)', readOnlyHint: true }
    ),
    defineTool(
      'create_attachment',
      'Create a new attachment on a note. Returns the created attachment metadata. ' +
        `${CONTENT_SOURCE_GUIDANCE} ` +
        'mime and title are optional — auto-detected/derived from the source ' +
        '(magic bytes, data-URL header, or file extension); a path or URL basename becomes the title. ' +
        'Simplest call: {ownerId, role: "image", content: "/tmp/screenshot.png"}.',
      createAttachmentSchema,
      {
        title: 'Create attachment',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      }
    ),
    defineTool(
      'write_attachment',
      'Update an attachment. Three modes via "mode":\n' +
        '- "metadata": update role/mime/title/position (no content change)\n' +
        '- "replace": overwrite the attachment body — accepts a local file path, http(s) URL, ' +
        'data URL, base64 (binary types), or raw text (text types); the stored mime is kept\n' +
        '- "edit": apply "changes" (search/replace blocks) or "patch" (unified diff) to existing text content\n\n' +
        '"edit" mode only works for text content — it fetches existing content, applies the diff, and verifies the result.',
      writeAttachmentSchema,
      {
        title: 'Write attachment',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      }
    ),
    defineTool(
      'delete_attachment',
      'Delete an attachment by ID. This permanently removes the attachment and its content.',
      deleteAttachmentSchema,
      {
        title: 'Delete attachment',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      }
    ),
  ];
}

// ============================================================================
// Dispatch
// ============================================================================

export async function handleAttachmentTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
} | null> {
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
          'UNDETECTABLE_MIME',
          'A title is required when the content source has no filename (inline base64 or raw text).',
          'Provide a title (e.g. "screenshot.png"), or pass a file path or URL whose basename can serve as one.'
        );
      }
      if (resolved.isBinary) {
        const result = await client.createAttachment({
          ownerId: parsed.ownerId,
          role: parsed.role,
          mime: resolved.mime,
          title,
          content: '',
          position: parsed.position,
        });
        await client.updateAttachmentContentBinary(result.attachmentId, resolved.buffer);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }
      const result = await client.createAttachment({
        ownerId: parsed.ownerId,
        role: parsed.role,
        mime: resolved.mime,
        title,
        content: resolved.buffer.toString('utf8'),
        position: parsed.position,
      });
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

      if (isImageMimeType(attachment.mime)) {
        const base64Content = await client.getAttachmentContentAsBase64(attachmentId);
        return {
          content: [
            {
              type: 'image',
              data: base64Content,
              mimeType: attachment.mime,
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
      const existing = await client.getAttachmentContent(parsed.attachmentId);
      const finalContent = await resolveContent(existing, {
        changes: parsed.changes,
        patch: parsed.patch,
      });
      await client.updateAttachmentContent(parsed.attachmentId, finalContent);

      if (parsed.changes !== undefined) {
        const readBack = await client.getAttachmentContent(parsed.attachmentId);
        verifySearchReplaceResults(readBack, parsed.changes);
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
