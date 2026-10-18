import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import type { NoteType, PatchNoteDef } from '../types/etapi.js';
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
import {
  isImageMimeType,
  isBinaryMimeType,
  resolveContentInput,
  CONTENT_SOURCE_GUIDANCE,
} from './contentInput.js';
import { searchReplaceBlockSchema, resolveContent, verifySearchReplaceResults } from './diff.js';
import { CONTENT_CHAR_CAP } from './contentLimits.js';
import { hasNoteLinkPlaceholders, needsLinkIndexing, resolveNoteLinks } from './noteLinks.js';

const imageEntrySchema = z.object({
  data: z.string().describe(`The image. ${CONTENT_SOURCE_GUIDANCE}`),
  mime: z
    .string()
    .optional()
    .describe(
      'Optional MIME type (e.g., "image/png") — auto-detected from the source; set only to override.'
    ),
  filename: z
    .string()
    .optional()
    .describe(
      'Optional filename for the image attachment (e.g., "screenshot.png"). ' +
        'Defaults to the path/URL basename, else image-N.'
    ),
});

const imagesFieldSchema = z
  .array(imageEntrySchema)
  .optional()
  .describe(
    'Optional array of images to embed in the note. The data field accepts a local file path, an http(s) URL, ' +
      'a data URL, or raw base64 — auto-detected; mime and filename are optional. ' +
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
/** Extensions for default attachment names, keyed by resolved MIME. */
const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
};

function defaultAttachmentName(prefix: string, index: number, mime: string): string {
  const ext = MIME_EXTENSION[mime.toLowerCase()];
  return ext ? `${prefix}-${index}.${ext}` : `${prefix}-${index}`;
}

async function processImages(
  client: TriliumClient,
  ownerId: string,
  htmlContent: string,
  images: Array<{ data: string; mime?: string; filename?: string }>
): Promise<string> {
  const attachments = await Promise.all(
    images.map(async (img, i) => {
      const resolved = await resolveContentInput(img.data, {
        mime: img.mime,
        filename: img.filename,
      });
      const title =
        img.filename ?? resolved.sourceName ?? defaultAttachmentName('image', i, resolved.mime);
      const attachment = await client.createAttachment({
        ownerId,
        role: 'image',
        mime: resolved.mime,
        title,
        content: '',
      });
      await client.updateAttachmentContentBinary(attachment.attachmentId, resolved.buffer);
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
  data: z.string().describe(`The file. ${CONTENT_SOURCE_GUIDANCE}`),
  mime: z
    .string()
    .optional()
    .describe(
      'Optional MIME type (e.g., "application/pdf", "text/csv") — auto-detected from the source; ' +
        'set only to override.'
    ),
  filename: z
    .string()
    .optional()
    .describe(
      'Optional filename for the file attachment (e.g., "report.pdf"). ' +
        'Defaults to the path/URL basename, else file-N.'
    ),
});

const filesFieldSchema = z
  .array(fileEntrySchema)
  .optional()
  .describe(
    'Optional array of files to attach and embed as download links in the note. The data field accepts a local file path, ' +
      'an http(s) URL, a data URL, raw base64 (binary types), or raw text (text types) — auto-detected; mime and filename are optional. ' +
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
  files: Array<{ data: string; mime?: string; filename?: string }>
): Promise<string> {
  const attachments = await Promise.all(
    files.map(async (file, i) => {
      const resolved = await resolveContentInput(file.data, {
        mime: file.mime,
        filename: file.filename,
      });
      const title =
        file.filename ?? resolved.sourceName ?? defaultAttachmentName('file', i, resolved.mime);
      if (resolved.isBinary) {
        const attachment = await client.createAttachment({
          ownerId,
          role: 'file',
          mime: resolved.mime,
          title,
          content: '',
        });
        await client.updateAttachmentContentBinary(attachment.attachmentId, resolved.buffer);
        return attachment;
      }
      return client.createAttachment({
        ownerId,
        role: 'file',
        mime: resolved.mime,
        title,
        content: resolved.buffer.toString('utf8'),
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
  'Internal links to other Trilium notes: write <a href="note:TARGET_NOTE_ID">Link text</a> in HTML, or ' +
  '[Link text](note:TARGET_NOTE_ID) in markdown — the server turns it into a proper Trilium reference link ' +
  '(class="reference-link" + href/data-note-path built from the target\'s tree path) and rejects the write if ' +
  "the target does not exist. Leave the link text empty to use the target's title. " +
  'Do NOT write [text](#root/...) markdown links or hand-built anchors without class="reference-link" and ' +
  'data-note-path — Trilium stores those as inert hash anchors, not note links.';

export const NOTE_URL_GUIDANCE =
  'The response includes a "url" field that opens this note directly in Trilium. ' +
  'When you have finished, give this URL to the user so they can jump straight to the note.';

const createNoteSchema = z.object({
  parentNoteId: z
    .string()
    .min(1, 'Parent note ID is required')
    .describe(
      'ID of the parent note. Before choosing a parent, use search_notes and get_note_tree to explore the existing note hierarchy and find the most appropriate location. Only use "root" when the note truly belongs at the top level — most notes belong under an existing section or folder.'
    ),
  title: z.string().min(1, 'Title is required').describe('Title of the new note'),
  type: noteTypeSchema.describe(
    'Type of the note. For runnable scripts, render notes, or widgets, see the server instructions ' +
      'for the required mime and the follow-up set_attribute wiring that makes them work.'
  ),
  content: z
    .string()
    .describe(
      'Content of the note. For text notes: provide HTML (default) or markdown (if format is "markdown"). ' +
        'For code notes: provide raw code. ' +
        'For binary notes (file/image types with a binary mime): provide base64, a data URL, ' +
        'a local file path, or an http(s) URL — auto-detected. ' +
        'For code blocks in HTML, use <pre><code class="language-X">...</code></pre> structure ' +
        '(e.g., language-mermaid, language-javascript). The class must be on the <code> element, not <pre>. ' +
        INTERNAL_LINK_GUIDANCE
    ),
  format: z
    .enum(['html', 'markdown'])
    .default('html')
    .describe(
      'Content format for text notes. Use "markdown" to automatically convert markdown to HTML. ' +
        'Defaults to "html". Only applies to text notes.'
    ),
  mime: z
    .string()
    .optional()
    .describe(
      'MIME type (required for code, file, image notes). Examples: application/javascript, text/x-python, text/markdown. ' +
        'For runnable scripts use application/javascript;env=frontend (browser) or application/javascript;env=backend (server). ' +
        'canvas/mindMap use application/json; render notes use an empty mime.'
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
  utcDateModified: utcDateTimeSchema
    .optional()
    .describe(
      'Set the UTC last-modified date (e.g. to keep the original date of a note migrated from another app). ' +
        'Format: "2024-01-15 09:30:00.000Z". Needs a Trilium newer than 0.105 (older ones reject it).'
    ),
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
    .default('html')
    .describe(
      'Content format. Use "markdown" to convert stored HTML to markdown. Defaults to "html". ' +
        'Ignored when include_content=false.'
    ),
  includeImages: z
    .boolean()
    .default(true)
    .describe(
      'Whether to fetch embedded images as MCP image blocks. Defaults to true. ' +
        'Ignored when include_content=false.'
    ),
  content_start: z
    .number()
    .int('content_start must be an integer')
    .min(0, 'content_start must be >= 0')
    .default(0)
    .describe(
      'Character offset into the (format-converted) content to start from — for paging through ' +
        'large notes. Defaults to 0. The metadata block reports the returned range and total size.'
    ),
  content_max_chars: z
    .number()
    .int('content_max_chars must be an integer')
    .min(1, 'content_max_chars must be at least 1')
    .max(500_000, 'content_max_chars cannot exceed 500000')
    .default(CONTENT_CHAR_CAP)
    .describe(
      `Maximum content characters to return (default ${CONTENT_CHAR_CAP}). When the note is larger, ` +
        'the content is truncated with a notice explaining how to fetch the rest.'
    ),
  include_path: z
    .boolean()
    .default(false)
    .describe(
      'Add "paths" to the metadata: for every place the note sits in the tree (one per parent, clones ' +
        'included), the noteId path and a human-readable title breadcrumb like "root > Projects > Plan". ' +
        'Use it to tell the user WHERE a note lives.'
    ),
  include_backlinks: z
    .boolean()
    .default(false)
    .describe(
      'Add "backlinks" to the metadata: notes whose content links to (or mentions the ID of) this note, ' +
        'with noteId and title (max 50). Relations without a link in the content (e.g. ~author) are not included.'
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
    dateCreated: localDateTimeSchema
      .optional()
      .describe(
        'New local creation date (metadata mode only). Format: "2024-01-15 10:30:00.000+0100"'
      ),
    utcDateCreated: utcDateTimeSchema
      .optional()
      .describe('New UTC creation date (metadata mode only). Format: "2024-01-15 09:30:00.000Z"'),
    utcDateModified: utcDateTimeSchema
      .optional()
      .describe(
        "New UTC last-modified date (metadata mode only), e.g. to restore a migrated note's original date " +
          'after rewriting its content. Format: "2024-01-15 09:30:00.000Z". Needs a Trilium newer than 0.105.'
      ),
    type: noteTypeSchema.optional().describe('New type (metadata mode only)'),
    mime: z
      .string()
      .optional()
      .describe(
        'New MIME type (metadata mode only). For runnable scripts use application/javascript;env=frontend ' +
          'or application/javascript;env=backend; see the server instructions for the attribute wiring.'
      ),
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
      .default('html')
      .describe(
        'Content format for text notes. Use "markdown" to auto-convert markdown to HTML. ' +
          'Defaults to "html". Only applies in "replace"/"append" modes.'
      ),
    images: imagesFieldSchema,
    files: filesFieldSchema,
  })
  .check((ctx) => {
    const { mode, title, type, mime, content, changes, patch, format, images, files } = ctx.value;
    const dateFields = [ctx.value.dateCreated, ctx.value.utcDateCreated, ctx.value.utcDateModified];
    const hasDates = dateFields.some((v) => v !== undefined);

    if (mode !== 'metadata' && hasDates) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message:
          'dateCreated/utcDateCreated/utcDateModified are metadata fields — set them with mode="metadata" ' +
          '(in a separate call after the content write, since a content write bumps the modified date)',
        path: [],
      });
    }

    if (mode === 'metadata') {
      if (title === undefined && type === undefined && mime === undefined && !hasDates) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message:
            'mode="metadata" requires at least one of "title", "type", "mime", "dateCreated", ' +
            '"utcDateCreated", or "utcDateModified"',
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
          message:
            'format="markdown" cannot be used with mode="edit" — diffs operate on stored HTML',
          path: ['format'],
        });
      }
      if ((images?.length ?? 0) > 0 || (files?.length ?? 0) > 0) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message:
            'mode="edit" cannot include images/files — use mode="replace"/"append" to embed attachments',
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
  limit: z
    .number()
    .int('limit must be an integer')
    .min(1, 'limit must be at least 1')
    .max(1000, 'limit cannot exceed 1000')
    .default(100)
    .describe('Maximum number of changes to return, newest first (default 100, max 1000).'),
});

// ============================================================================
// Note context helpers
// ============================================================================

/** Bound the ancestor walks one get_note call can trigger. */
const MAX_PATHS = 10;
const MAX_BACKLINKS = 50;

type NoteMeta = Awaited<ReturnType<TriliumClient['getNote']>>;

/** One breadcrumb per tree placement (clones have several). */
async function buildNotePaths(
  client: TriliumClient,
  note: NoteMeta
): Promise<Array<{ path: string; breadcrumb: string }>> {
  const titles = new Map<string, string>([[note.noteId, note.title]]);
  const titleOf = async (id: string): Promise<string> => {
    const cached = titles.get(id);
    if (cached !== undefined) return cached;
    const title = id === 'root' ? 'root' : (await client.getNote(id)).title;
    titles.set(id, title);
    return title;
  };

  const parents = note.noteId === 'root' ? [undefined] : note.parentNoteIds.slice(0, MAX_PATHS);
  return Promise.all(
    parents.map(async (parentId) => {
      const path = await client.getNotePath(note.noteId, parentId);
      const crumbs = await Promise.all(path.split('/').map(titleOf));
      return { path, breadcrumb: crumbs.join(' > ') };
    })
  );
}

async function findBacklinks(
  client: TriliumClient,
  noteId: string
): Promise<Array<{ noteId: string; title: string }>> {
  // Trilium has no "any relation pointing here" query, but every in-content link
  // carries the target's noteId (href/data-note-path), so a content scan for the
  // ID finds links regardless of whether Trilium has indexed them as relations.
  const response = await client.searchNotes({
    search: `note.content *=* "${noteId}"`,
    limit: MAX_BACKLINKS + 1,
  });
  return response.results
    .filter((n) => n.noteId !== noteId)
    .slice(0, MAX_BACKLINKS)
    .map((n) => ({ noteId: n.noteId, title: n.title }));
}

// ============================================================================
// Registration
// ============================================================================

export function registerNoteTools(): Tool[] {
  return [
    // Read-first ordering improves default tool-choice heuristics in most LLMs
    // and lets clients with first-N pre-load policies load reads before writes.
    defineTool(
      'get_note',
      'Read a note. The response has two text blocks — first the metadata JSON (title, type, attributes, ' +
        'parent/child IDs, plus a contentInfo object with total size and the returned character range), then the ' +
        'note body (HTML by default, or markdown with format="markdown") — followed by any embedded image ' +
        `attachments as MCP image blocks. Bodies over ${CONTENT_CHAR_CAP} characters are truncated with a notice; ` +
        'page through large notes with content_start/content_max_chars. ' +
        'This is the canonical and complete way to read a note — DO NOT bypass this tool by calling the Trilium HTTP/ETAPI directly ' +
        '(e.g. via curl, fetch, or shell). The response format is already designed for direct LLM consumption. ' +
        'If you only need the title, type, attributes, or parent/child IDs (e.g. for tree navigation), pass include_content=false to skip the body. ' +
        'Pass include_path=true for human-readable breadcrumbs of where the note lives, and include_backlinks=true for the notes that link to it.',
      getNoteSchema,
      { title: 'Read note', readOnlyHint: true }
    ),
    defineTool(
      'get_note_history',
      'Get recent changes across the note tree — creations, modifications, and deletions. Optionally filter by subtree via ancestorNoteId. ' +
        'Returns {changes, total, returned, truncated}; pass limit (default 100) to see more. ' +
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
        'Unresolved placeholders will cause the call to fail with a clear error. ' +
        NOTE_URL_GUIDANCE,
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
        '"edit" mode operates on stored HTML and cannot be combined with format="markdown" or images/files. ' +
        NOTE_URL_GUIDANCE,
      writeNoteSchema,
      { title: 'Write note', readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    ),
    defineTool(
      'delete_note',
      'Delete or restore a note. Required "action": "delete" soft-deletes the note (and all its branches); "undelete" restores a previously-deleted note. ' +
        'Restoring requires at least one undeleted parent. Use get_note_history to find deleted notes.',
      deleteNoteSchema,
      {
        title: 'Delete or restore note',
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

export async function handleNoteTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
} | null> {
  switch (name) {
    case 'create_note': {
      const parsed = createNoteSchema.parse(args);
      const isBinary = parsed.mime ? isBinaryMimeType(parsed.mime) : false;
      // Binary content is normalized BEFORE any format conversion — running
      // markdown conversion on a base64 string would corrupt it.
      const binaryContent = isBinary
        ? (
            await resolveContentInput(parsed.content, {
              mime: parsed.mime,
              filename: parsed.title,
            })
          ).buffer
        : null;
      let content = isBinary ? '' : await convertContent(parsed.content, parsed.format);
      if (parsed.type === 'text') {
        content = await resolveNoteLinks(client, content);
      }
      let warning: string | undefined;
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
        utcDateModified: parsed.utcDateModified,
      });

      if (binaryContent && binaryContent.length > 0) {
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
        // For a binary note the body IS the binary blob — writing the
        // placeholder HTML would overwrite it.
        if (!isBinary) {
          await client.updateNoteContent(result.note.noteId, content);
        }
      } else if (parsed.type === 'text' && needsLinkIndexing(content)) {
        // Re-save so Trilium indexes the links (backlinks, note map); see needsLinkIndexing.
        // The note already exists at this point, so a failure here must not surface
        // as a failed create — the caller would retry and duplicate the note.
        try {
          await client.updateNoteContent(result.note.noteId, content);
          if (parsed.utcDateModified) {
            // The re-save stamped "now" — put the requested modified date back.
            await client.updateNote(result.note.noteId, {
              utcDateModified: parsed.utcDateModified,
            });
          }
        } catch (error) {
          warning =
            'Note created, but re-saving it so Trilium indexes its links failed ' +
            `(${error instanceof Error ? error.message : String(error)}). The links work, but may not ` +
            'appear in backlinks/note map until the note is next edited. Do NOT re-create the note.';
        }
      }

      const url = await client.getNoteUrl(result.note.noteId, result.branch.parentNoteId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { note: result.note, branch: result.branch, url, ...(warning ? { warning } : {}) },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'get_note': {
      const parsed = getNoteSchema.parse(args);
      const note = await client.getNote(parsed.noteId);
      const [paths, backlinks] = await Promise.all([
        parsed.include_path ? buildNotePaths(client, note) : undefined,
        parsed.include_backlinks ? findBacklinks(client, note.noteId) : undefined,
      ]);
      const meta = {
        ...note,
        ...(paths ? { paths } : {}),
        ...(backlinks ? { backlinks } : {}),
      };

      if (!parsed.include_content) {
        return {
          content: [{ type: 'text', text: JSON.stringify(meta, null, 2) }],
        };
      }

      const rawHtml = await client.getNoteContent(parsed.noteId);
      const converted = parsed.format === 'markdown' ? convertHtmlToMarkdown(rawHtml) : rawHtml;

      const totalChars = converted.length;
      const start = Math.min(parsed.content_start, totalChars);
      const end = Math.min(start + parsed.content_max_chars, totalChars);
      const truncated = end < totalChars;
      let textContent = converted.slice(start, end);
      if (truncated) {
        textContent +=
          `\n\n---\n**Content truncated:** showing characters ${start}-${end} of ${totalChars}. ` +
          `Call get_note again with content_start=${end} to continue` +
          (parsed.format === 'markdown'
            ? '.'
            : ' (format="markdown" is usually more token-efficient).');
      }

      const metaBlock = {
        ...meta,
        contentInfo: {
          format: parsed.format,
          totalChars,
          returnedStart: start,
          returnedEnd: end,
          truncated,
        },
      };

      const out: Array<
        { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
      > = [{ type: 'text', text: JSON.stringify(metaBlock, null, 2) }];

      const wantImages = parsed.includeImages !== false;
      if (wantImages) {
        const attachments = await client.getNoteAttachments(parsed.noteId);
        const imageAttachments = attachments.filter((a) => isImageMimeType(a.mime));
        const otherAttachments = attachments.filter((a) => !isImageMimeType(a.mime));

        const imageResults = await Promise.all(
          imageAttachments.map(async (a) => {
            try {
              const data = await client.getAttachmentContentAsBase64(a.attachmentId);
              return {
                attachmentId: a.attachmentId,
                success: true as const,
                data,
                mimeType: a.mime,
              };
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
            .map(
              (a) => `- **${a.title || a.attachmentId}** (${a.mime}) - ID: \`${a.attachmentId}\``
            )
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
        const patch: PatchNoteDef = {};
        if (parsed.title !== undefined) patch.title = parsed.title;
        if (parsed.type !== undefined) patch.type = parsed.type as NoteType;
        if (parsed.mime !== undefined) patch.mime = parsed.mime;
        if (parsed.dateCreated !== undefined) patch.dateCreated = parsed.dateCreated;
        if (parsed.utcDateCreated !== undefined) patch.utcDateCreated = parsed.utcDateCreated;
        if (parsed.utcDateModified !== undefined) patch.utcDateModified = parsed.utcDateModified;
        const result = await client.updateNote(parsed.noteId, patch);
        const url = await client.getNoteUrl(parsed.noteId, result.parentNoteIds?.[0]);
        return {
          content: [{ type: 'text', text: JSON.stringify({ ...result, url }, null, 2) }],
        };
      }

      let finalContent: string;
      let appliedChanges = parsed.changes;

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
        // Resolve note: placeholders inside each new_string up front, so the
        // read-back verification below checks for the text actually written.
        if (appliedChanges?.some((c) => hasNoteLinkPlaceholders(c.new_string))) {
          if ((await client.getNote(parsed.noteId)).type === 'text') {
            appliedChanges = await Promise.all(
              appliedChanges.map(async (c) => ({
                ...c,
                new_string: await resolveNoteLinks(client, c.new_string),
              }))
            );
          }
        }
        finalContent = await resolveContent(existing, {
          changes: appliedChanges,
          patch: parsed.patch,
        });
      }

      if (hasNoteLinkPlaceholders(finalContent)) {
        // Only text notes hold HTML links; a code note may legitimately contain
        // the literal string, so check the type before rewriting anything.
        const target = await client.getNote(parsed.noteId);
        if (target.type === 'text') {
          finalContent = await resolveNoteLinks(client, finalContent);
        }
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
        verifySearchReplaceResults(readBack, appliedChanges ?? parsed.changes);
      }

      const url = await client.getNoteUrl(parsed.noteId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: true, noteId: parsed.noteId, mode: parsed.mode, url },
              null,
              2
            ),
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
              text: JSON.stringify(
                { success: true, noteId: parsed.noteId, action: 'delete' },
                null,
                2
              ),
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
      const changes = history.slice(0, parsed.limit);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                changes,
                total: history.length,
                returned: changes.length,
                truncated: changes.length < history.length,
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
