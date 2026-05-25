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
import { isImageMimeType, isBinaryMimeType, base64ToBuffer } from './attachments.js';
import { searchReplaceBlockSchema, resolveContent, verifySearchReplaceResults } from './diff.js';

/**
 * Parse a data URL (data:mime;base64,content) and extract the MIME type and base64 content.
 * Returns null if the string is not a data URL.
 */
function parseDataUrl(data: string): { mime: string; base64: string } | null {
  const match = data.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

/**
 * Resolve the data field: if it's a data URL, extract base64 + mime (overriding explicit mime).
 * If it's raw base64, return as-is with the explicit mime.
 */
function resolveAttachmentData(entry: { data: string; mime: string }): { data: string; mime: string } {
  const parsed = parseDataUrl(entry.data);
  if (parsed) {
    return { data: parsed.base64, mime: parsed.mime };
  }
  return { data: entry.data, mime: entry.mime };
}

const imageEntrySchema = z.object({
  data: z.string().describe(
    'Image data as base64 string or data URL (data:image/png;base64,...). ' +
    'When using a data URL, the MIME type is extracted automatically and overrides the mime field.'
  ),
  mime: z.string().describe('MIME type of the image (e.g., "image/png", "image/jpeg"). Ignored if data is a data URL.'),
  filename: z.string().describe('Filename for the image attachment (e.g., "screenshot.png")'),
});

const imagesFieldSchema = z.array(imageEntrySchema).optional().describe(
  'Optional array of images to embed in the note. The data field accepts raw base64 or a data URL (data:image/png;base64,...). ' +
  'Reference images in your content using placeholder URLs: in markdown use ![alt](image:0), ![alt](image:1), etc. ' +
  'In HTML use <img src="image:0"> (double quotes required). The number is the zero-based index into THIS array — ' +
  'placeholders do NOT reference attachments uploaded in earlier calls. Images and placeholders must be provided together in the same call. ' +
  'Images without a corresponding placeholder are appended at the end of the content. ' +
  'To reference an attachment you uploaded separately, use its real URL: <img src="api/attachments/{attachmentId}/image/{filename}">.'
);

/**
 * Create attachments for each image and replace placeholder references in HTML content.
 * Placeholders use the format src="image:N" where N is the zero-based index.
 * Images not referenced by a placeholder are appended at the end of the content.
 */
async function processImages(
  client: TriliumClient,
  ownerId: string,
  htmlContent: string,
  images: Array<{ data: string; mime: string; filename: string }>
): Promise<string> {
  const attachments = await Promise.all(
    images.map(async (img) => {
      const resolved = resolveAttachmentData(img);
      const attachment = await client.createAttachment({
        ownerId,
        role: 'image',
        mime: resolved.mime,
        title: img.filename,
        content: '',
      });
      const binaryContent = base64ToBuffer(resolved.data);
      await client.updateAttachmentContentBinary(attachment.attachmentId, binaryContent);
      return attachment;
    })
  );

  let result = htmlContent;
  const referencedIndices = new Set<number>();

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const realSrc = `api/attachments/${att.attachmentId}/image/${att.title}`;
    const placeholder = new RegExp(`src="image:${i}"`, 'g');
    if (placeholder.test(result)) {
      referencedIndices.add(i);
      result = result.replace(placeholder, `src="${realSrc}"`);
    }
  }

  for (let i = 0; i < attachments.length; i++) {
    if (!referencedIndices.has(i)) {
      const att = attachments[i];
      const realSrc = `api/attachments/${att.attachmentId}/image/${att.title}`;
      result += `\n<p><img src="${realSrc}"></p>`;
    }
  }

  return result;
}

const fileEntrySchema = z.object({
  data: z.string().describe(
    'File data as base64 string or data URL (data:application/pdf;base64,...). ' +
    'When using a data URL, the MIME type is extracted automatically and overrides the mime field.'
  ),
  mime: z.string().describe('MIME type of the file (e.g., "application/pdf", "text/csv"). Ignored if data is a data URL.'),
  filename: z.string().describe('Filename for the file attachment (e.g., "report.pdf")'),
});

const filesFieldSchema = z.array(fileEntrySchema).optional().describe(
  'Optional array of files to attach and embed as download links in the note. The data field accepts raw base64 or a data URL. ' +
  'Reference files in your content using placeholder URLs: in markdown use [label](file:0), [label](file:1), etc. ' +
  'In HTML use <a href="file:0">label</a> (double quotes required). The number is the zero-based index into THIS array — ' +
  'placeholders do NOT reference attachments uploaded in earlier calls. Files and placeholders must be provided together in the same call. ' +
  'Files without a corresponding placeholder are appended at the end of the content as download links. ' +
  'To reference an attachment you uploaded separately, use its real URL: <a href="api/attachments/{attachmentId}/download">label</a>.'
);

/**
 * Create attachments for each file and replace placeholder references in HTML content.
 */
async function processFiles(
  client: TriliumClient,
  ownerId: string,
  htmlContent: string,
  files: Array<{ data: string; mime: string; filename: string }>
): Promise<string> {
  const attachments = await Promise.all(
    files.map(async (file) => {
      const resolved = resolveAttachmentData(file);
      if (isBinaryMimeType(resolved.mime)) {
        const attachment = await client.createAttachment({
          ownerId,
          role: 'file',
          mime: resolved.mime,
          title: file.filename,
          content: '',
        });
        const binaryContent = base64ToBuffer(resolved.data);
        await client.updateAttachmentContentBinary(attachment.attachmentId, binaryContent);
        return attachment;
      }
      return client.createAttachment({
        ownerId,
        role: 'file',
        mime: resolved.mime,
        title: file.filename,
        content: resolved.data,
      });
    })
  );

  let result = htmlContent;
  const referencedIndices = new Set<number>();

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const realHref = `api/attachments/${att.attachmentId}/download`;
    const placeholder = new RegExp(`href="file:${i}"`, 'g');
    if (placeholder.test(result)) {
      referencedIndices.add(i);
      result = result.replace(placeholder, `href="${realHref}"`);
    }
  }

  for (let i = 0; i < attachments.length; i++) {
    if (!referencedIndices.has(i)) {
      const att = attachments[i];
      const realHref = `api/attachments/${att.attachmentId}/download`;
      result += `\n<p><a href="${realHref}">${att.title}</a></p>`;
    }
  }

  return result;
}

/**
 * Scan final HTML for any remaining image:N / file:N placeholders that didn't get
 * resolved. Trilium silently strips unknown src/href values, so we fail loudly.
 */
function assertPlaceholdersResolved(html: string): void {
  const unresolved = new Set<string>();
  const imgPattern = /src=["']image:(\d+)["']/g;
  const filePattern = /href=["']file:(\d+)["']/g;
  for (const match of html.matchAll(imgPattern)) unresolved.add(`image:${match[1]}`);
  for (const match of html.matchAll(filePattern)) unresolved.add(`file:${match[1]}`);
  if (unresolved.size === 0) return;
  const list = Array.from(unresolved).join(', ');
  throw new Error(
    `Unresolved placeholder(s) in content: ${list}. ` +
      'Placeholders like <img src="image:N"> and <a href="file:N"> are only resolved when the ' +
      '`images`/`files` array is provided in the SAME call (N indexes into that array). ' +
      'Common causes: missing `images`/`files` array, index out of range, or single-quoted attributes. ' +
      'To reference an attachment you uploaded separately, use its real URL instead: ' +
      '<img src="api/attachments/{attachmentId}/image/{filename}"> or ' +
      '<a href="api/attachments/{attachmentId}/download">label</a>.'
  );
}

async function convertContent(content: string, format?: 'html' | 'markdown'): Promise<string> {
  if (format === 'markdown') {
    return await marked.parse(content);
  }
  return content;
}

function convertHtmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });
  return turndownService.turndown(html);
}

// ============================================================================
// Schemas
// ============================================================================

const INTERNAL_LINK_GUIDANCE =
  'Internal links to other Trilium notes must be raw HTML with this exact structure: ' +
  '<a class="reference-link" href="#root/<path>/<targetNoteId>" data-note-path="root/<path>/<targetNoteId>">Title</a>. ' +
  'All three attributes are required — Trilium only renders a true note-to-note link when class="reference-link" AND data-note-path are both present; drop either and it stores an inert hash anchor. ' +
  'The two path strings point to the same target but differ by one character: href starts with "#root/...", data-note-path is the same string without the leading "#". ' +
  'To build the path: call get_note on the target noteId and prepend each parent from parentNoteIds until you reach "root", giving "root/.../targetNoteId". For a note with one parent (the common case) this is one walk; for cloned notes any valid path works. ' +
  'When format="markdown", do NOT use markdown link syntax for internal links — [text](#root/...) gets converted to a bare <a href> without class/data-note-path and Trilium will not render it as a reference link. Write the full <a class="reference-link" ...> tag as raw HTML inside the markdown content. ' +
  'Example: <a class="reference-link" href="#root/abc123def/xyz789ghi" data-note-path="root/abc123def/xyz789ghi">Project Plan</a>.';

const createNoteSchema = z.object({
  parentNoteId: z
    .string()
    .min(1, 'Parent note ID is required')
    .describe('ID of the parent note. Before choosing a parent, use search_notes and get_note_tree to explore the existing note hierarchy and find the most appropriate location. Only use "root" when the note truly belongs at the top level — most notes belong under an existing section or folder.'),
  title: z.string().min(1, 'Title is required').describe('Title of the new note'),
  type: noteTypeSchema.describe('Type of the note'),
  content: z
    .string()
    .describe(
      'Content of the note. For text notes: provide HTML (default) or markdown (if format is "markdown"). ' +
        'For code notes: provide raw code. ' +
        'For code blocks in HTML, use <pre><code class="language-X">...</code></pre> structure ' +
        '(e.g., language-mermaid, language-javascript). The class must be on the <code> element, not <pre>. ' +
        INTERNAL_LINK_GUIDANCE
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
  images: imagesFieldSchema,
  files: filesFieldSchema,
});

const getNoteSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to retrieve'),
  include_content: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Whether to include the note body in the response. Defaults to true — the response contains the content ' +
        '(HTML by default, or markdown if format="markdown") plus image blocks for any embedded image attachments. ' +
        'Set to false only for metadata-only navigation (walking the tree, inspecting attributes/parents/children) ' +
        'where you explicitly do not need the body.'
    ),
  format: z
    .enum(['html', 'markdown'])
    .optional()
    .describe(
      'Content format. Use "markdown" to convert stored HTML to markdown. Defaults to "html". ' +
        'Ignored when include_content=false.'
    ),
  includeImages: z
    .boolean()
    .optional()
    .describe(
      'Whether to fetch embedded images as MCP image blocks. Defaults to true. ' +
        'Ignored when include_content=false.'
    ),
});

const writeNoteSchema = z
  .object({
    noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to write to'),
    mode: z
      .enum(['metadata', 'replace', 'append', 'edit'])
      .describe(
        'Write mode. ' +
          '"metadata" — update title/type/mime only (no content change). ' +
          '"replace" — overwrite the entire content with the provided content. ' +
          '"append" — fetch existing content and concatenate the provided content at the end. ' +
          '"edit" — apply search/replace blocks (changes) or a unified diff (patch) to the existing content.'
      ),
    title: z.string().optional().describe('New title (metadata mode only)'),
    type: noteTypeSchema.optional().describe('New type (metadata mode only)'),
    mime: z.string().optional().describe('New MIME type (metadata mode only)'),
    content: z
      .string()
      .optional()
      .describe(
        'New content. Required for "replace" and "append" modes. ' +
          'For text notes: provide HTML (default) or markdown (if format is "markdown"). ' +
          'For code blocks in HTML, use <pre><code class="language-X">...</code></pre> structure. ' +
          INTERNAL_LINK_GUIDANCE
      ),
    changes: z
      .array(searchReplaceBlockSchema)
      .optional()
      .describe(
        '"edit" mode: array of search/replace blocks applied sequentially. ' +
          'Each block has old_string (exact match) and new_string (replacement). ' +
          'Operates on stored content (HTML for text notes).'
      ),
    patch: z
      .string()
      .optional()
      .describe('"edit" mode: unified diff to apply to existing content.'),
    format: z
      .enum(['html', 'markdown'])
      .optional()
      .describe(
        'Content format for text notes. Use "markdown" to auto-convert markdown to HTML. ' +
          'Defaults to "html". Only applies in "replace"/"append" modes.'
      ),
    images: imagesFieldSchema,
    files: filesFieldSchema,
  })
  .check((ctx) => {
    const { mode, title, type, mime, content, changes, patch, format, images, files } = ctx.value;

    if (mode === 'metadata') {
      if (title === undefined && type === undefined && mime === undefined) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'mode="metadata" requires at least one of "title", "type", or "mime"',
          path: [],
        });
      }
      const disallowed = [content, changes, patch, images, files].some((v) => v !== undefined);
      if (disallowed) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'mode="metadata" cannot include content/changes/patch/images/files',
          path: [],
        });
      }
    } else if (mode === 'replace' || mode === 'append') {
      if (content === undefined) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: `mode="${mode}" requires "content"`,
          path: ['content'],
        });
      }
      if (changes !== undefined || patch !== undefined) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: `mode="${mode}" cannot include "changes" or "patch" (use mode="edit" instead)`,
          path: [],
        });
      }
      if (title !== undefined || type !== undefined || mime !== undefined) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: `mode="${mode}" cannot include "title"/"type"/"mime" (use mode="metadata" in a separate call)`,
          path: [],
        });
      }
    } else if (mode === 'edit') {
      const diffModes = [changes !== undefined, patch !== undefined].filter(Boolean).length;
      if (diffModes === 0) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'mode="edit" requires exactly one of "changes" or "patch"',
          path: [],
        });
      } else if (diffModes > 1) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'mode="edit" cannot include both "changes" and "patch"',
          path: [],
        });
      }
      if (content !== undefined) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'mode="edit" cannot include "content" (use mode="replace"/"append" instead)',
          path: ['content'],
        });
      }
      if (format === 'markdown') {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'format="markdown" cannot be used with mode="edit" — diffs operate on stored HTML',
          path: ['format'],
        });
      }
      if ((images?.length ?? 0) > 0 || (files?.length ?? 0) > 0) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'mode="edit" cannot include images/files — use mode="replace"/"append" to embed attachments',
          path: [],
        });
      }
    }
  });

const deleteNoteSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note'),
  action: z
    .enum(['delete', 'undelete'])
    .describe(
      '"delete" removes the note (and all branches pointing to it). ' +
        '"undelete" restores a previously-deleted note (requires at least one undeleted parent). ' +
        'Use get_note_history to find deleted notes.'
    ),
});

const getNoteHistorySchema = z.object({
  ancestorNoteId: z
    .string()
    .optional()
    .describe('Limit changes to a subtree identified by this note ID. Defaults to all notes.'),
});

// ============================================================================
// Registration
// ============================================================================

export function registerNoteTools(): Tool[] {
  return [
    // Read-first ordering improves default tool-choice heuristics in most LLMs
    // and lets clients with first-N pre-load policies load reads before writes.
    defineTool(
      'get_note',
      'Read a note. Returns the note body (HTML by default, or markdown with format="markdown") together with metadata ' +
        '(title, type, attributes, parent/child IDs) and any embedded image attachments as MCP image blocks. ' +
        'This is the canonical and complete way to read a note — DO NOT bypass this tool by calling the Trilium HTTP/ETAPI directly ' +
        '(e.g. via curl, fetch, or shell). The response format is already designed for direct LLM consumption. ' +
        'If you only need the title, type, attributes, or parent/child IDs (e.g. for tree navigation), pass include_content=false to skip the body.',
      getNoteSchema,
      { title: 'Read note', readOnlyHint: true }
    ),
    defineTool(
      'get_note_history',
      'Get recent changes across the note tree — creations, modifications, and deletions. Optionally filter by subtree via ancestorNoteId. ' +
        'Distinct from revisions: this is a change log across notes; revisions are content snapshots of a single note.',
      getNoteHistorySchema,
      { title: 'Note change history', readOnlyHint: true }
    ),
    defineTool(
      'create_note',
      'Create a new note with title, content, type, and parent. Returns the created note and its branch. ' +
        'IMPORTANT: Before creating a note, use search_notes and get_note_tree to explore the existing note hierarchy and find the best parent. Suggest a location to the user and confirm before creating. Avoid placing notes at root unless they truly belong there. ' +
        'Supports positioning, tree display, and date options. For text notes, content can be HTML (default) or markdown (set format to "markdown"). ' +
        'Supports embedding images and files: pass "images" and/or "files" arrays with base64 data IN THE SAME CALL, and reference them in content using image:0/file:0 placeholders (e.g., <img src="image:0"> or <a href="file:0">). ' +
        'The N in image:N / file:N indexes into the array provided in this call — it does NOT reference attachments uploaded previously. ' +
        'Unresolved placeholders will cause the call to fail with a clear error.',
      createNoteSchema,
      { title: 'Create note', readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    ),
    defineTool(
      'write_note',
      'Write to an existing note. Four modes selected via "mode":\n' +
        '- "metadata": update title/type/mime only (no content change)\n' +
        '- "replace": overwrite content entirely with "content"\n' +
        '- "append": fetch current content and concatenate "content" at the end\n' +
        '- "edit": apply "changes" (array of {old_string, new_string}) OR "patch" (unified diff) to existing content\n\n' +
        'For "replace"/"append" on text notes, "content" can be HTML (default) or markdown (set format="markdown"). ' +
        'To embed images/files, pass "images"/"files" arrays with base64 data and reference them via image:0/file:0 placeholders in "content". ' +
        'Unresolved placeholders will cause the call to fail with a clear error. ' +
        '"edit" mode operates on stored HTML and cannot be combined with format="markdown" or images/files.',
      writeNoteSchema,
      { title: 'Write note', readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    ),
    defineTool(
      'delete_note',
      'Delete or restore a note. Required "action": "delete" soft-deletes the note (and all its branches); "undelete" restores a previously-deleted note. ' +
        'Restoring requires at least one undeleted parent. Use get_note_history to find deleted notes.',
      deleteNoteSchema,
      { title: 'Delete or restore note', readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    ),
  ];
}

// ============================================================================
// Dispatch
// ============================================================================

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
      let content = await convertContent(parsed.content, parsed.format);
      const isBinary = parsed.mime ? isBinaryMimeType(parsed.mime) : false;
      const hasAttachments =
        (parsed.images && parsed.images.length > 0) || (parsed.files && parsed.files.length > 0);
      if (!isBinary && !hasAttachments) {
        assertPlaceholdersResolved(content);
      }
      const result = await client.createNote({
        parentNoteId: parsed.parentNoteId,
        title: parsed.title,
        type: parsed.type as NoteType,
        content: isBinary ? '' : content,
        mime: parsed.mime,
        notePosition: parsed.notePosition,
        prefix: parsed.prefix,
        isExpanded: parsed.isExpanded,
        noteId: parsed.noteId,
        branchId: parsed.branchId,
        dateCreated: parsed.dateCreated,
        utcDateCreated: parsed.utcDateCreated,
      });

      if (isBinary && content) {
        const binaryContent = base64ToBuffer(content);
        await client.updateNoteContentBinary(result.note.noteId, binaryContent);
      }

      if (hasAttachments) {
        if (parsed.images && parsed.images.length > 0) {
          content = await processImages(client, result.note.noteId, content, parsed.images);
        }
        if (parsed.files && parsed.files.length > 0) {
          content = await processFiles(client, result.note.noteId, content, parsed.files);
        }
        assertPlaceholdersResolved(content);
        await client.updateNoteContent(result.note.noteId, content);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ note: result.note, branch: result.branch }, null, 2),
          },
        ],
      };
    }

    case 'get_note': {
      const parsed = getNoteSchema.parse(args);
      const meta = await client.getNote(parsed.noteId);

      if (!parsed.include_content) {
        return {
          content: [{ type: 'text', text: JSON.stringify(meta, null, 2) }],
        };
      }

      const rawHtml = await client.getNoteContent(parsed.noteId);
      const textContent = parsed.format === 'markdown' ? convertHtmlToMarkdown(rawHtml) : rawHtml;

      const out: Array<
        { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
      > = [];

      const wantImages = parsed.includeImages !== false;
      if (wantImages) {
        const attachments = await client.getNoteAttachments(parsed.noteId);
        const imageAttachments = attachments.filter((a) => isImageMimeType(a.mime));
        const otherAttachments = attachments.filter((a) => !isImageMimeType(a.mime));

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
            `that can be fetched by calling get_attachment with the attachmentId below:\n${attachmentList}`;
        }

        if (failed.length > 0) {
          const warnings = failed.map((f) => `- ${f.attachmentId}: ${f.error}`).join('\n');
          finalText += `\n\n---\n**Note:** Some attachments could not be loaded:\n${warnings}`;
        }

        out.push({ type: 'text', text: finalText });
        for (const img of fetched) {
          out.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        }
      } else {
        out.push({ type: 'text', text: textContent });
      }

      return { content: out };
    }

    case 'write_note': {
      const parsed = writeNoteSchema.parse(args);

      if (parsed.mode === 'metadata') {
        const patch: { title?: string; type?: NoteType; mime?: string } = {};
        if (parsed.title !== undefined) patch.title = parsed.title;
        if (parsed.type !== undefined) patch.type = parsed.type as NoteType;
        if (parsed.mime !== undefined) patch.mime = parsed.mime;
        const result = await client.updateNote(parsed.noteId, patch);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      let finalContent: string;

      if (parsed.mode === 'replace') {
        finalContent = await resolveContent(
          '',
          { content: parsed.content },
          parsed.format === 'markdown' ? (c) => convertContent(c, 'markdown') : undefined
        );
      } else if (parsed.mode === 'append') {
        const existing = await client.getNoteContent(parsed.noteId);
        const newContent = await convertContent(parsed.content ?? '', parsed.format);
        finalContent = existing + newContent;
      } else {
        // edit
        const existing = await client.getNoteContent(parsed.noteId);
        finalContent = await resolveContent(existing, {
          changes: parsed.changes,
          patch: parsed.patch,
        });
      }

      if (parsed.images && parsed.images.length > 0) {
        finalContent = await processImages(client, parsed.noteId, finalContent, parsed.images);
      }
      if (parsed.files && parsed.files.length > 0) {
        finalContent = await processFiles(client, parsed.noteId, finalContent, parsed.files);
      }

      assertPlaceholdersResolved(finalContent);
      await client.updateNoteContent(parsed.noteId, finalContent);

      if (parsed.mode === 'edit' && parsed.changes !== undefined) {
        const readBack = await client.getNoteContent(parsed.noteId);
        verifySearchReplaceResults(readBack, parsed.changes);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, noteId: parsed.noteId, mode: parsed.mode }, null, 2),
          },
        ],
      };
    }

    case 'delete_note': {
      const parsed = deleteNoteSchema.parse(args);
      if (parsed.action === 'delete') {
        await client.deleteNote(parsed.noteId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, noteId: parsed.noteId, action: 'delete' }, null, 2),
            },
          ],
        };
      }
      const result = await client.undeleteNote(parsed.noteId);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
