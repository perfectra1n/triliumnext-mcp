import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { positionSchema } from './validators.js';

// Supported image MIME types for visual content display
const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

function isImageMimeType(mime: string): boolean {
  return IMAGE_MIME_TYPES.has(mime.toLowerCase());
}

// Zod schemas for validation
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
    .min(1, 'MIME type is required')
    .describe('MIME type of the attachment (e.g., "image/png", "application/pdf")'),
  title: z.string().min(1, 'Title is required').describe('Title/filename of the attachment'),
  content: z.string().describe('Content of the attachment (base64-encoded for binary files)'),
  position: positionSchema.optional().describe('Position for ordering (10, 20, 30...)'),
});

const getAttachmentSchema = z.object({
  attachmentId: z
    .string()
    .min(1, 'Attachment ID is required')
    .describe('ID of the attachment to retrieve'),
});

const updateAttachmentSchema = z.object({
  attachmentId: z
    .string()
    .min(1, 'Attachment ID is required')
    .describe('ID of the attachment to update'),
  role: z.string().optional().describe('New role for the attachment'),
  mime: z.string().optional().describe('New MIME type for the attachment'),
  title: z.string().optional().describe('New title/filename for the attachment'),
  position: positionSchema.optional().describe('New position for ordering'),
});

const deleteAttachmentSchema = z.object({
  attachmentId: z
    .string()
    .min(1, 'Attachment ID is required')
    .describe('ID of the attachment to delete'),
});

const getAttachmentContentSchema = z.object({
  attachmentId: z
    .string()
    .min(1, 'Attachment ID is required')
    .describe('ID of the attachment to get content from'),
});

const updateAttachmentContentSchema = z.object({
  attachmentId: z
    .string()
    .min(1, 'Attachment ID is required')
    .describe('ID of the attachment to update'),
  content: z.string().describe('New content for the attachment'),
});

export function registerAttachmentTools(): Tool[] {
  return [
    defineTool(
      'create_attachment',
      'Create a new attachment for a note. Attachments are files or images attached to notes. Returns the created attachment metadata.',
      createAttachmentSchema
    ),
    defineTool(
      'get_attachment',
      'Get attachment metadata by ID. Returns attachment properties including owner note ID, role, MIME type, title, and position.',
      getAttachmentSchema
    ),
    defineTool(
      'update_attachment',
      'Update attachment metadata (role, MIME type, title, or position). Does not update content - use update_attachment_content for that.',
      updateAttachmentSchema
    ),
    defineTool(
      'delete_attachment',
      'Delete an attachment by ID. This permanently removes the attachment and its content.',
      deleteAttachmentSchema
    ),
    defineTool(
      'get_attachment_content',
      'Get the content/body of an attachment. For text notes, returns the raw content as text. For image attachments (PNG, JPEG, GIF, WebP, SVG), returns the image for visual viewing.',
      getAttachmentContentSchema
    ),
    defineTool(
      'update_attachment_content',
      'Update the content/body of an attachment. Provide new content as text.',
      updateAttachmentContentSchema
    ),
  ];
}

export async function handleAttachmentTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
} | null> {
  switch (name) {
    case 'create_attachment': {
      const parsed = createAttachmentSchema.parse(args);
      const result = await client.createAttachment({
        ownerId: parsed.ownerId,
        role: parsed.role,
        mime: parsed.mime,
        title: parsed.title,
        content: parsed.content,
        position: parsed.position,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'get_attachment': {
      const parsed = getAttachmentSchema.parse(args);
      const result = await client.getAttachment(parsed.attachmentId);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'update_attachment': {
      const parsed = updateAttachmentSchema.parse(args);
      const patch: { role?: string; mime?: string; title?: string; position?: number } = {};
      if (parsed.role) patch.role = parsed.role;
      if (parsed.mime) patch.mime = parsed.mime;
      if (parsed.title) patch.title = parsed.title;
      if (parsed.position) patch.position = parsed.position;
      const result = await client.updateAttachment(parsed.attachmentId, patch);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'delete_attachment': {
      const parsed = deleteAttachmentSchema.parse(args);
      await client.deleteAttachment(parsed.attachmentId);
      return {
        content: [{ type: 'text', text: `Attachment ${parsed.attachmentId} deleted successfully` }],
      };
    }

    case 'get_attachment_content': {
      const parsed = getAttachmentContentSchema.parse(args);
      const attachment = await client.getAttachment(parsed.attachmentId);

      if (isImageMimeType(attachment.mime)) {
        // Fetch as binary and convert to base64 for proper MCP image content
        const base64Content = await client.getAttachmentContentAsBase64(parsed.attachmentId);
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

      // For non-images, fetch as text
      const content = await client.getAttachmentContent(parsed.attachmentId);
      return {
        content: [{ type: 'text', text: content }],
      };
    }

    case 'update_attachment_content': {
      const parsed = updateAttachmentContentSchema.parse(args);
      await client.updateAttachmentContent(parsed.attachmentId, parsed.content);
      return {
        content: [{ type: 'text', text: 'Attachment content updated successfully' }],
      };
    }

    default:
      return null;
  }
}
