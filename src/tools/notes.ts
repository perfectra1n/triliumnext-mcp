import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import type { NoteType } from '../types/etapi.js';
import { defineTool } from './schemas.js';
import {
  noteTypeSchema,
  optionalEntityIdSchema,
  localDateTimeSchema,
  utcDateTimeSchema,
  positionSchema,
} from './validators.js';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { isImageMimeType } from './attachments.js';
import { searchReplaceBlockSchema, resolveContent, verifySearchReplaceResults } from './diff.js';

/**
 * Convert markdown content to HTML if format is 'markdown'.
 * Returns content unchanged if format is 'html' or undefined.
 */
async function convertContent(content: string, format?: 'html' | 'markdown'): Promise<string> {
  if (format === 'markdown') {
    return await marked.parse(content);
  }
  return content;
}

/**
 * Convert HTML content to markdown.
 */
function convertHtmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });
  return turndownService.turndown(html);
}

// Zod schemas for validation
const createNoteSchema = z.object({
  parentNoteId: z
    .string()
    .min(1, 'Parent note ID is required')
    .describe('ID of the parent note (use "root" for top-level)'),
  title: z.string().min(1, 'Title is required').describe('Title of the new note'),
  type: noteTypeSchema.describe('Type of the note'),
  content: z
    .string()
    .describe(
      'Content of the note. For text notes: provide HTML (default) or markdown (if format is "markdown"). ' +
        'For code notes: provide raw code. ' +
        'For code blocks in HTML, use <pre><code class="language-X">...</code></pre> structure ' +
        '(e.g., language-mermaid, language-javascript). The class must be on the <code> element, not <pre>. ' +
        'For internal links to other notes, use: ' +
        '<a class="reference-link" href="#root/path/to/noteId" data-note-path="root/path/to/noteId">Link Text</a>. ' +
        'The path should be the full note path from root (e.g., root/parentId/childId). ' +
        "Use get_note to find a note's path via its parentNoteIds."
    ),
  format: z
    .enum(['html', 'markdown'])
    .optional()
    .describe(
      'Content format for text notes. Use "markdown" to automatically convert markdown to HTML. ' +
        'Defaults to "html". Only applies to text notes.'
    ),
  mime: z
    .string()
    .optional()
    .describe(
      'MIME type (required for code, file, image notes). Examples: application/javascript, text/x-python, text/markdown'
    ),
  notePosition: positionSchema
    .optional()
    .describe('Position in parent (10, 20, 30...). Use 5 for first position, 1000000 for last'),
  prefix: z
    .string()
    .optional()
    .describe('Branch-specific title prefix (e.g., "Archive:", "Draft:")'),
  isExpanded: z
    .boolean()
    .optional()
    .describe('Whether this note (as a folder) should appear expanded in the tree'),
  noteId: optionalEntityIdSchema.describe(
    'Force a specific note ID (for imports/migrations). Must be 4-32 alphanumeric chars.'
  ),
  branchId: optionalEntityIdSchema.describe(
    'Force a specific branch ID (for imports/migrations). Must be 4-32 alphanumeric chars.'
  ),
  dateCreated: localDateTimeSchema
    .optional()
    .describe('Set creation date for backdating. Format: "2024-01-15 10:30:00.000+0100"'),
  utcDateCreated: utcDateTimeSchema
    .optional()
    .describe('Set UTC creation date. Format: "2024-01-15 09:30:00.000Z"'),
});

const getNoteSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to retrieve'),
});

const getNoteContentSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to get content from'),
  format: z
    .enum(['html', 'markdown'])
    .optional()
    .describe(
      'Output format for text notes. Use "markdown" to convert HTML to markdown. ' +
        'Defaults to "html" (returns content as stored). Only applies to text notes.'
    ),
  includeImages: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), fetches note attachments and includes images as image content blocks. ' +
        'Set false for text-only.'
    ),
});

const updateNoteSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to update'),
  title: z.string().optional().describe('New title for the note'),
  type: noteTypeSchema.optional().describe('New type for the note'),
  mime: z.string().optional().describe('New MIME type for the note'),
});

const updateNoteContentSchema = z
  .object({
    noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to update'),
    content: z
      .string()
      .optional()
      .describe(
        'Full replacement content for the note. For text notes: provide HTML (default) or markdown (if format is "markdown"). ' +
          'For text notes with code blocks, use ' +
          '<pre><code class="language-X">...</code></pre> structure (e.g., language-mermaid). ' +
          'The class must be on the <code> element, not <pre>. ' +
          'For internal links to other notes, use: ' +
          '<a class="reference-link" href="#root/path/to/noteId" data-note-path="root/path/to/noteId">Link Text</a>. ' +
          "The path should be the full note path from root. Use get_note to find paths."
      ),
    changes: z
      .array(searchReplaceBlockSchema)
      .optional()
      .describe(
        'Array of search/replace blocks to apply sequentially. Each block has old_string (exact match to find) ' +
          'and new_string (replacement). Operates on stored content (HTML for text notes). ' +
          'Cannot be used with format="markdown".'
      ),
    patch: z
      .string()
      .optional()
      .describe(
        'Unified diff patch to apply to the existing content. ' +
          'Cannot be used with format="markdown".'
      ),
    format: z
      .enum(['html', 'markdown'])
      .optional()
      .describe(
        'Content format for text notes. Use "markdown" to automatically convert markdown to HTML. ' +
          'Defaults to "html". Only applies to full content replacement mode.'
      ),
  })
  .check((ctx) => {
    const { content, changes, patch, format } = ctx.value;
    const modes = [content !== undefined, changes !== undefined, patch !== undefined].filter(
      Boolean
    ).length;
    if (modes === 0) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Exactly one of "content", "changes", or "patch" must be provided',
        path: [],
      });
    } else if (modes > 1) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Only one of "content", "changes", or "patch" can be provided at a time',
        path: [],
      });
    }
    if (format === 'markdown' && (changes !== undefined || patch !== undefined)) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message:
          'format="markdown" cannot be used with "changes" or "patch" modes — diffs operate on stored content (HTML)',
        path: ['format'],
      });
    }
  });

const deleteNoteSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to delete'),
});

const appendNoteContentSchema = z
  .object({
    noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to append content to'),
    content: z
      .string()
      .optional()
      .describe(
        'Content to append to the note. For text notes: provide HTML (default) or markdown (if format is "markdown"). ' +
          'For text notes with code blocks, use ' +
          '<pre><code class="language-X">...</code></pre> structure (e.g., language-mermaid). ' +
          'The class must be on the <code> element, not <pre>. ' +
          'For internal links to other notes, use: ' +
          '<a class="reference-link" href="#root/path/to/noteId" data-note-path="root/path/to/noteId">Link Text</a>. ' +
          "The path should be the full note path from root. Use get_note to find paths."
      ),
    changes: z
      .array(searchReplaceBlockSchema)
      .optional()
      .describe(
        'Array of search/replace blocks to apply sequentially to the existing content. ' +
          'Cannot be used with format="markdown".'
      ),
    patch: z
      .string()
      .optional()
      .describe(
        'Unified diff patch to apply to the existing content. ' +
          'Cannot be used with format="markdown".'
      ),
    format: z
      .enum(['html', 'markdown'])
      .optional()
      .describe(
        'Content format for text notes. Use "markdown" to automatically convert markdown to HTML. ' +
          'Defaults to "html". Only applies to full content append mode.'
      ),
  })
  .check((ctx) => {
    const { content, changes, patch, format } = ctx.value;
    const modes = [content !== undefined, changes !== undefined, patch !== undefined].filter(
      Boolean
    ).length;
    if (modes === 0) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Exactly one of "content", "changes", or "patch" must be provided',
        path: [],
      });
    } else if (modes > 1) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Only one of "content", "changes", or "patch" can be provided at a time',
        path: [],
      });
    }
    if (format === 'markdown' && (changes !== undefined || patch !== undefined)) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message:
          'format="markdown" cannot be used with "changes" or "patch" modes — diffs operate on stored content (HTML)',
        path: ['format'],
      });
    }
  });

const undeleteNoteSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the deleted note to restore'),
});

const getNoteAttachmentsSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to get attachments for'),
});

const getNoteHistorySchema = z.object({
  ancestorNoteId: z
    .string()
    .optional()
    .describe('Limit changes to a subtree identified by this note ID. Defaults to all notes.'),
});

export function registerNoteTools(): Tool[] {
  return [
    defineTool(
      'create_note',
      'Create a new note with title, content, type, and parent. Returns the created note and its branch. Supports positioning, tree display, and date options. For text notes, content can be HTML (default) or markdown (set format to "markdown").',
      createNoteSchema
    ),
    defineTool(
      'get_note',
      'Get note metadata by ID. Returns note properties including title, type, attributes, and child/parent relationships.',
      getNoteSchema
    ),
    defineTool(
      'get_note_content',
      'Get the content/body of a note. For text notes, returns HTML by default or markdown. ' +
        'By default, embedded images are automatically fetched and included as image content blocks. ' +
        'Set includeImages to false for text-only output.',
      getNoteContentSchema
    ),
    defineTool(
      'update_note',
      'Update note metadata (title, type, or MIME type). Does not update content - use update_note_content for that.',
      updateNoteSchema
    ),
    defineTool(
      'update_note_content',
      'Update the content/body of a note. Three modes: (1) Full replacement via "content" — provide HTML (default) or markdown (set format to "markdown"). ' +
        '(2) Search/replace via "changes" — array of {old_string, new_string} blocks applied sequentially to existing content. ' +
        '(3) Unified diff via "patch" — a unified diff string applied to existing content. ' +
        'Exactly one mode must be used per call.',
      updateNoteContentSchema
    ),
    defineTool(
      'append_note_content',
      'Append or edit content of an existing note. Three modes: (1) Append via "content" — fetches current content and appends new content at the end. ' +
        '(2) Search/replace via "changes" — array of {old_string, new_string} blocks applied sequentially to existing content. ' +
        '(3) Unified diff via "patch" — a unified diff string applied to existing content. ' +
        'Exactly one mode must be used per call.',
      appendNoteContentSchema
    ),
    defineTool(
      'delete_note',
      'Delete a note by ID. This will also delete all branches pointing to this note.',
      deleteNoteSchema
    ),
    defineTool(
      'undelete_note',
      'Restore a deleted note. The note must have been deleted and must have at least one undeleted parent. Use get_note_history to find deleted notes that can be undeleted.',
      undeleteNoteSchema
    ),
    defineTool(
      'get_note_attachments',
      'Get all attachments for a note by its ID. Returns array of attachment metadata including role, MIME type, title, and size. Use get_attachment_content to retrieve attachment contents.',
      getNoteAttachmentsSchema
    ),
    defineTool(
      'get_note_history',
      'Get recent changes including note creations, modifications, and deletions. Optionally filter by subtree using ancestorNoteId. Returns change events with note info and deletion/undelete status.',
      getNoteHistorySchema
    ),
  ];
}

export async function handleNoteTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
} | null> {
  switch (name) {
    case 'create_note': {
      const parsed = createNoteSchema.parse(args);
      const content = await convertContent(parsed.content, parsed.format);
      const result = await client.createNote({
        parentNoteId: parsed.parentNoteId,
        title: parsed.title,
        type: parsed.type as NoteType,
        content,
        mime: parsed.mime,
        notePosition: parsed.notePosition,
        prefix: parsed.prefix,
        isExpanded: parsed.isExpanded,
        noteId: parsed.noteId,
        branchId: parsed.branchId,
        dateCreated: parsed.dateCreated,
        utcDateCreated: parsed.utcDateCreated,
      });
      return {
        content: [{ type: 'text', text: `Note created successfully. noteId: ${result.note.noteId}, branchId: ${result.branch.branchId}, title: ${result.note.title}` }],
      };
    }

    case 'get_note': {
      const parsed = getNoteSchema.parse(args);
      const result = await client.getNote(parsed.noteId);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'get_note_content': {
      const parsed = getNoteContentSchema.parse(args);
      const rawHtml = await client.getNoteContent(parsed.noteId);
      const textContent = parsed.format === 'markdown' ? convertHtmlToMarkdown(rawHtml) : rawHtml;

      const content: Array<
        { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
      > = [];

      if (parsed.includeImages !== false) {
        const attachments = await client.getNoteAttachments(parsed.noteId);
        const imageAttachments = attachments.filter((a) => isImageMimeType(a.mime));
        const otherAttachments = attachments.filter((a) => !isImageMimeType(a.mime));

        // Fetch image content in parallel
        const imageResults = await Promise.all(
          imageAttachments.map(async (a) => {
            try {
              const data = await client.getAttachmentContentAsBase64(a.attachmentId);
              return { attachmentId: a.attachmentId, success: true as const, data, mimeType: a.mime };
            } catch (error) {
              return {
                attachmentId: a.attachmentId,
                success: false as const,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          })
        );

        const fetched = imageResults.filter((r) => r.success);
        const failed = imageResults.filter((r) => !r.success);

        let finalText = textContent;

        if (otherAttachments.length > 0) {
          const attachmentList = otherAttachments
            .map((a) => `- **${a.title || a.attachmentId}** (${a.mime}) - ID: \`${a.attachmentId}\``)
            .join('\n');
          finalText +=
            `\n\n---\n**Attachments:** This note has ${otherAttachments.length} non-image attachment(s) ` +
            `that can be fetched using \`get_attachment_content\`:\n${attachmentList}`;
        }

        if (failed.length > 0) {
          const warnings = failed.map((f) => `- ${f.attachmentId}: ${f.error}`).join('\n');
          finalText += `\n\n---\n**Note:** Some attachments could not be loaded:\n${warnings}`;
        }

        content.push({ type: 'text', text: finalText });
        for (const img of fetched) {
          content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        }
      } else {
        content.push({ type: 'text', text: textContent });
      }

      return { content };
    }

    case 'update_note': {
      const parsed = updateNoteSchema.parse(args);
      const patch: { title?: string; type?: NoteType; mime?: string } = {};
      if (parsed.title) patch.title = parsed.title;
      if (parsed.type) patch.type = parsed.type as NoteType;
      if (parsed.mime) patch.mime = parsed.mime;
      const result = await client.updateNote(parsed.noteId, patch);
      return {
        content: [{ type: 'text', text: `Note ${result.noteId} updated successfully` }],
      };
    }

    case 'update_note_content': {
      const parsed = updateNoteContentSchema.parse(args);
      let finalContent: string;
      if (parsed.changes !== undefined || parsed.patch !== undefined) {
        // Diff modes: fetch existing content first
        const existingContent = await client.getNoteContent(parsed.noteId);
        finalContent = await resolveContent(existingContent, {
          changes: parsed.changes,
          patch: parsed.patch,
        });
      } else {
        // Full replacement mode
        finalContent = await resolveContent('', {
          content: parsed.content,
        }, parsed.format === 'markdown' ? (c) => convertContent(c, 'markdown') : undefined);
      }
      await client.updateNoteContent(parsed.noteId, finalContent);

      // Verify search/replace changes were actually persisted
      if (parsed.changes !== undefined) {
        const readBack = await client.getNoteContent(parsed.noteId);
        verifySearchReplaceResults(readBack, parsed.changes);
      }

      return {
        content: [{ type: 'text', text: 'Note content updated successfully' }],
      };
    }

    case 'append_note_content': {
      const parsed = appendNoteContentSchema.parse(args);
      const existingContent = await client.getNoteContent(parsed.noteId);
      let finalContent: string;
      if (parsed.changes !== undefined || parsed.patch !== undefined) {
        // Diff modes: apply diffs to existing content
        finalContent = await resolveContent(existingContent, {
          changes: parsed.changes,
          patch: parsed.patch,
        });
      } else {
        // Append mode: concatenate new content to existing
        const newContent = await convertContent(parsed.content ?? '', parsed.format);
        finalContent = existingContent + newContent;
      }
      await client.updateNoteContent(parsed.noteId, finalContent);

      // Verify search/replace changes were actually persisted
      if (parsed.changes !== undefined) {
        const readBack = await client.getNoteContent(parsed.noteId);
        verifySearchReplaceResults(readBack, parsed.changes);
      }

      return {
        content: [{ type: 'text', text: 'Content appended to note successfully' }],
      };
    }

    case 'delete_note': {
      const parsed = deleteNoteSchema.parse(args);
      await client.deleteNote(parsed.noteId);
      return {
        content: [{ type: 'text', text: `Note ${parsed.noteId} deleted successfully` }],
      };
    }

    case 'undelete_note': {
      const parsed = undeleteNoteSchema.parse(args);
      const result = await client.undeleteNote(parsed.noteId);
      return {
        content: [
          {
            type: 'text',
            text: result.success
              ? `Note ${parsed.noteId} has been restored successfully.`
              : `Failed to restore note ${parsed.noteId}.`,
          },
        ],
      };
    }

    case 'get_note_attachments': {
      const parsed = getNoteAttachmentsSchema.parse(args);
      const attachments = await client.getNoteAttachments(parsed.noteId);
      return {
        content: [{ type: 'text', text: JSON.stringify(attachments, null, 2) }],
      };
    }

    case 'get_note_history': {
      const parsed = getNoteHistorySchema.parse(args);
      const history = await client.getNoteHistory(parsed.ancestorNoteId);
      return {
        content: [{ type: 'text', text: JSON.stringify(history, null, 2) }],
      };
    }

    default:
      return null;
  }
}
