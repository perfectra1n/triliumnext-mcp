import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { positionSchema } from './validators.js';

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
      'Get the content/body of an attachment. Returns the raw content as text.',
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
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
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
      const result = await client.getAttachmentContent(parsed.attachmentId);
      return {
        content: [{ type: 'text', text: result }],
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
