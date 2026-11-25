import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import type { Attachment, NoteType, PatchNoteDef } from '../types/etapi.js';
import { defineTool, type ToolContentBlock, type ToolHandlerResult } from './schemas.js';
import {
  entityIdSchema,
  required,
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
import {
  escapeHtml,
  hasNoteLinkPlaceholders,
  needsLinkIndexing,
  resolveNoteLinks,
} from './noteLinks.js';

const imageEntrySchema = z.object({
  data: z.string().describe(`The image. ${CONTENT_SOURCE_GUIDANCE}`),
  mime: z
    .string()
    .optional()
    .describe('MIME type override (e.g. "image/png"); normally auto-detected.'),
  filename: z
    .string()
    .optional()
    .describe(
      'Attachment filename (e.g. "chart.png"). Defaults to the path/URL basename, else image-N.'
    ),
});

const imagesFieldSchema = z
  .array(imageEntrySchema)
  .optional()
  .describe(
    'Images to upload as attachments of this note and embed. Reference entry N from the content with ' +
      '<img src="image:N"> (HTML, double quotes) or ![alt](image:N) (markdown); N indexes THIS array only, ' +
      'not attachments from earlier calls. Unreferenced images are appended at the end; an unresolved ' +
      'placeholder fails the call. To embed an existing attachment use its real URL: ' +
      '<img src="api/attachments/{attachmentId}/image/{filename}">.'
  );

const fileEntrySchema = z.object({
  data: z.string().describe(`The file. ${CONTENT_SOURCE_GUIDANCE}`),
  mime: z
    .string()
    .optional()
    .describe('MIME type override (e.g. "application/pdf"); normally auto-detected.'),
  filename: z
    .string()
    .optional()
    .describe(
      'Attachment filename (e.g. "report.pdf"). Defaults to the path/URL basename, else file-N.'
    ),
});

const filesFieldSchema = z
  .array(fileEntrySchema)
  .optional()
  .describe(
    'Files to upload as attachments of this note and link as downloads. Reference entry N with ' +
      '<a href="file:N">label</a> (HTML, double quotes) or [label](file:N) (markdown); same indexing rules ' +
      'as images. Unreferenced files are appended as download links. To link an existing attachment use ' +
      '<a href="api/attachments/{attachmentId}/download">label</a>.'
  );

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

type EntryInput = { data: string; mime?: string; filename?: string };

/** An image/file input fully resolved to bytes, ready to upload. */
interface StagedAttachment {
  role: 'image' | 'file';
  index: number;
  title: string;
  mime: string;
  isBinary: boolean;
  buffer: Buffer;
}

/**
 * Resolve every image/file input (paths, URLs, base64...) to bytes up front,
 * so a bad input fails the call before anything is created in Trilium.
 */
async function stageAttachments(
  images: EntryInput[] | undefined,
  files: EntryInput[] | undefined
): Promise<StagedAttachment[]> {
  const stage = (entries: EntryInput[] | undefined, role: 'image' | 'file') =>
    (entries ?? []).map(async (entry, index): Promise<StagedAttachment> => {
      const resolved = await resolveContentInput(entry.data, {
        mime: entry.mime,
        filename: entry.filename,
      });
      return {
        role,
        index,
        title:
          entry.filename ??
          resolved.sourceName ??
          defaultAttachmentName(role, index, resolved.mime),
        mime: resolved.mime,
        // Images always go up as raw bytes; files follow their MIME type.
        isBinary: role === 'image' || resolved.isBinary,
        buffer: resolved.buffer,
      };
    });
  return Promise.all([...stage(images, 'image'), ...stage(files, 'file')]);
}

interface UploadedAttachment {
  staged: StagedAttachment;
  attachment: Attachment;
}

/** Thrown when some staged attachments could not be uploaded. */
class AttachmentUploadError extends Error {
  constructor(
    public readonly uploaded: UploadedAttachment[],
    public readonly failures: Array<{ staged: StagedAttachment; error: string }>
  ) {
    super(
      `${failures.length} attachment upload(s) failed: ` +
        failures
          .map((f) => `${f.staged.role}:${f.staged.index} (${f.staged.title}): ${f.error}`)
          .join('; ')
    );
    this.name = 'AttachmentUploadError';
  }
}

async function uploadStaged(
  client: TriliumClient,
  ownerId: string,
  staged: StagedAttachment[]
): Promise<UploadedAttachment[]> {
  const results = await Promise.allSettled(
    staged.map(async (item): Promise<UploadedAttachment> => {
      const attachment = await client.createAttachment({
        ownerId,
        role: item.role,
        mime: item.mime,
        title: item.title,
        content: item.isBinary ? '' : item.buffer.toString('utf8'),
      });
      if (item.isBinary) {
        await client.updateAttachmentContentBinary(attachment.attachmentId, item.buffer);
      }
      return { staged: item, attachment };
    })
  );
  const uploaded: UploadedAttachment[] = [];
  const failures: Array<{ staged: StagedAttachment; error: string }> = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') uploaded.push(r.value);
    else {
      failures.push({
        staged: staged[i],
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });
  if (failures.length > 0) throw new AttachmentUploadError(uploaded, failures);
  return uploaded;
}

/**
 * Swap image:N / file:N placeholders for the uploaded attachments' real URLs;
 * attachments without a placeholder are appended at the end. Function
 * replacers keep "$&" / "$1" in filenames literal, titles are URL-encoded in
 * URLs and HTML-escaped in link text.
 */
export function substituteAttachmentPlaceholders(
  html: string,
  uploaded: UploadedAttachment[]
): string {
  let result = html;
  const appended: string[] = [];
  for (const { staged, attachment } of uploaded) {
    const id = encodeURIComponent(attachment.attachmentId);
    const pattern =
      staged.role === 'image'
        ? new RegExp(`src="image:${staged.index}"`, 'g')
        : new RegExp(`href="file:${staged.index}"`, 'g');
    const url =
      staged.role === 'image'
        ? `api/attachments/${id}/image/${encodeURIComponent(attachment.title)}`
        : `api/attachments/${id}/download`;
    if (pattern.test(result)) {
      pattern.lastIndex = 0;
      const replacement = staged.role === 'image' ? `src="${url}"` : `href="${url}"`;
      result = result.replace(pattern, () => replacement);
    } else {
      appended.push(
        staged.role === 'image'
          ? `\n<p><img src="${url}"></p>`
          : `\n<p><a href="${url}">${escapeHtml(attachment.title)}</a></p>`
      );
    }
  }
  return result + appended.join('');
}

const PLACEHOLDER_HELP =
  'Placeholders <img src="image:N"> and <a href="file:N"> resolve only against the images/files arrays ' +
  'of the SAME call (N is the zero-based index). Common causes: missing array, index out of range, or ' +
  'single-quoted attributes. For an existing attachment use its real URL: ' +
  '<img src="api/attachments/{attachmentId}/image/{filename}"> or ' +
  '<a href="api/attachments/{attachmentId}/download">label</a>.';

function findPlaceholders(html: string): Array<{ kind: 'image' | 'file'; index: number }> {
  const found: Array<{ kind: 'image' | 'file'; index: number }> = [];
  for (const m of html.matchAll(/src=["']image:(\d+)["']/g)) {
    found.push({ kind: 'image', index: Number(m[1]) });
  }
  for (const m of html.matchAll(/href=["']file:(\d+)["']/g)) {
    found.push({ kind: 'file', index: Number(m[1]) });
  }
  return found;
}

/**
 * Pre-flight check, run before anything is written: every placeholder must
 * be double-quoted and index into the images/files array of this call.
 */
function assertPlaceholdersResolvable(html: string, imageCount: number, fileCount: number): void {
  const bad = new Set<string>();
  for (const m of html.matchAll(/src='image:(\d+)'|href='file:(\d+)'/g)) bad.add(m[0]);
  for (const { kind, index } of findPlaceholders(html)) {
    if (index >= (kind === 'image' ? imageCount : fileCount)) bad.add(`${kind}:${index}`);
  }
  if (bad.size === 0) return;
  throw new Error(
    `Unresolvable placeholder(s) in content: ${[...bad].join(', ')}. Nothing was written. ${PLACEHOLDER_HELP}`
  );
}

/**
 * Scan final HTML for any remaining image:N / file:N placeholders. Trilium
 * silently strips unknown src/href values, so we fail loudly.
 */
function assertPlaceholdersResolved(html: string): void {
  const unresolved = new Set(findPlaceholders(html).map((p) => `${p.kind}:${p.index}`));
  if (unresolved.size === 0) return;
  throw new Error(
    `Unresolved placeholder(s) in content: ${[...unresolved].join(', ')}. ${PLACEHOLDER_HELP}`
  );
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
  'Link to another note with <a href="note:TARGET_NOTE_ID">text</a> (HTML) or [text](note:TARGET_NOTE_ID) ' +
  '(markdown): the server rewrites it into a real Trilium reference link and rejects unknown IDs; empty ' +
  'link text becomes the target title. Hand-written #root/... anchors are stored as inert links.';

export const NOTE_URL_GUIDANCE =
  'Returns a "url" that opens the note in Trilium; give it to the user.';

const EDIT_CHANGES_GUIDANCE =
  '"edit" mode: search/replace blocks applied in order to the STORED content — HTML for text notes, ' +
  'so read it with get_note format="html" first (markdown from get_note will not match). Each ' +
  'old_string must match exactly once; include surrounding context to make it unique. An empty ' +
  'old_string inserts new_string at the start.';

const EDIT_PATCH_GUIDANCE =
  '"edit" mode: a single-file unified diff (with @@ hunks) against the stored content. Trilium HTML is ' +
  'often one long line, so prefer "changes".';

const createNoteSchema = z.object({
  parentNoteId: entityIdSchema.describe(
    'ID of an existing parent note (find one with search_notes/get_note_tree); use "root" only for ' +
      'genuinely top-level notes.'
  ),
  title: z.string().min(1, 'Title is required').describe('Title of the new note'),
  type: noteTypeSchema.describe(
    'Type of the note. For runnable scripts, render notes, or widgets, see the server instructions ' +
      'for the required mime and the follow-up set_attribute wiring that makes them work.'
  ),
  content: z
    .string()
    .describe(
      'Note body. Text notes: HTML, or markdown with format="markdown"; code blocks as ' +
        '<pre><code class="language-X">...</code></pre> (class on <code>). Code/mermaid/canvas notes: the raw ' +
        `source. Binary notes (file/image with a binary mime): ${CONTENT_SOURCE_GUIDANCE} ` +
        INTERNAL_LINK_GUIDANCE
    ),
  format: z
    .enum(['html', 'markdown'])
    .default('html')
    .describe(
      '"markdown" converts content to HTML before saving. Applies to type="text" only; ignored for other types.'
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

/** get_note inlines referenced images only up to these sizes. */
const IMAGE_MAX_BYTES = 1024 * 1024;
const IMAGES_TOTAL_MAX_BYTES = 4 * 1024 * 1024;

const getNoteSchema = z.object({
  noteId: entityIdSchema.describe('ID of the note to retrieve'),
  include_content: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Include the note body (default true). Pass false for metadata-only navigation (title, type, ' +
        'attributes, parent/child IDs).'
    ),
  format: z
    .enum(['html', 'markdown'])
    .default('html')
    .describe(
      '"html" (default) returns the stored HTML — use it before write_note edits. "markdown" is a lossy, ' +
        'more compact view for reading only. Ignored when include_content=false.'
    ),
  includeImages: z
    .boolean()
    .default(true)
    .describe(
      'Return images embedded in the note body as image blocks — only on the first page ' +
        '(content_start=0), at most ~1 MB each and ~4 MB total; larger ones are listed for get_attachment. ' +
        'Costly; pass false when you only need text.'
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
    noteId: entityIdSchema.describe('ID of the note to write to'),
    mode: z
      .enum(['metadata', 'replace', 'append', 'edit'])
      .describe(
        'Write mode. ' +
          '"metadata" — update title/type/mime/dates only (no content change). ' +
          '"replace" — overwrite the entire content with the provided content. ' +
          '"append" — add the provided content at the end of the existing content (text/code notes). ' +
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
        'New content for "replace"/"append". Same conventions as create_note content (HTML or markdown, ' +
          'note:<id> links); for binary (file/image) notes "replace" takes a path, URL, data URL or base64.'
      ),
    changes: z.array(searchReplaceBlockSchema).optional().describe(EDIT_CHANGES_GUIDANCE),
    patch: z.string().optional().describe(EDIT_PATCH_GUIDANCE),
    format: z
      .enum(['html', 'markdown'])
      .default('html')
      .describe(
        '"markdown" converts content to HTML before saving ("replace"/"append" only). Applies to text ' +
          'notes only; ignored for other types.'
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
  noteId: entityIdSchema.describe('ID of the note'),
  action: z
    .enum(['delete', 'undelete'])
    .describe(
      '"delete" soft-deletes the note and all its branches; children with no other parent are deleted ' +
        'with it (the whole subtree), while clones placed elsewhere survive. "undelete" restores a ' +
        'deleted note (needs at least one non-deleted parent); find deleted notes with get_note_history.'
    ),
});

const getNoteHistorySchema = z.object({
  ancestorNoteId: entityIdSchema
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
      'Read a note. Returns a metadata JSON block (title, type, attributes, parent/child IDs, and ' +
        'contentInfo with the total size and returned character range), then the body (stored HTML by ' +
        'default), then any images embedded in the body. Bodies over ' +
        `${CONTENT_CHAR_CAP} characters are paged via content_start/content_max_chars. ` +
        'Pass include_content=false for metadata only, include_path=true for breadcrumbs of where the ' +
        'note lives, include_backlinks=true for notes linking to it.',
      getNoteSchema,
      { title: 'Read note', readOnlyHint: true, openWorldHint: false }
    ),
    defineTool(
      'get_note_history',
      'Get recent changes across the note tree — creations, modifications, and deletions. Optionally filter by subtree via ancestorNoteId. ' +
        'Returns {changes, total, returned, truncated}; pass limit (default 100) to see more. ' +
        'Distinct from revisions: this is a change log across notes; revisions are content snapshots of a single note.',
      getNoteHistorySchema,
      { title: 'Note change history', readOnlyHint: true, openWorldHint: false }
    ),
    defineTool(
      'create_note',
      'Create a note under an existing parent and return the note, its branch and a url. Pick the ' +
        'parent with search_notes/get_note_tree; use "root" only for genuinely top-level notes. Text ' +
        'content is HTML or markdown (format="markdown"). Images/files can be uploaded and embedded in ' +
        'the same call (see the images/files fields). Give the user the returned url.',
      createNoteSchema,
      {
        title: 'Create note',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      }
    ),
    defineTool(
      'write_note',
      'Change an existing note. mode="metadata" updates title/type/mime/dates; "replace" overwrites ' +
        'the content; "append" adds to the end; "edit" applies search/replace "changes" (preferred) or a ' +
        'unified diff "patch" to the stored HTML — read it with get_note format="html" first. ' +
        'replace/append can also upload and embed images/files. Give the user the returned url.',
      writeNoteSchema,
      {
        title: 'Write note',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      }
    ),
    defineTool(
      'delete_note',
      'Delete (soft) or restore a note. Deleting removes the note and every child that has no other ' +
        'parent; clones elsewhere survive. Restore with action="undelete".',
      deleteNoteSchema,
      {
        title: 'Delete or restore note',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      }
    ),
  ];
}

// ============================================================================
// Dispatch
// ============================================================================

const textResult = (value: unknown): { content: ToolContentBlock[] } => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const describeUploads = (uploaded: UploadedAttachment[]) =>
  uploaded.map((u) => ({
    placeholder: `${u.staged.role}:${u.staged.index}`,
    attachmentId: u.attachment.attachmentId,
    title: u.attachment.title,
  }));

async function createNote(client: TriliumClient, args: unknown): Promise<ToolHandlerResult> {
  const parsed = createNoteSchema.parse(args);
  const isBinary = parsed.mime ? isBinaryMimeType(parsed.mime) : false;
  const isText = parsed.type === 'text';

  // Resolve every input BEFORE creating anything, so a bad path/URL/base64
  // fails the call without leaving a half-built note behind. Binary content
  // is normalized before any format conversion (markdown would corrupt it).
  const [binaryContent, staged] = await Promise.all([
    isBinary
      ? resolveContentInput(parsed.content, { mime: parsed.mime, filename: parsed.title }).then(
          (r) => r.buffer
        )
      : Promise.resolve(null),
    stageAttachments(parsed.images, parsed.files),
  ]);

  let content = '';
  if (!isBinary) {
    content =
      isText && parsed.format === 'markdown' ? await marked.parse(parsed.content) : parsed.content;
    if (isText) {
      content = await resolveNoteLinks(client, content);
    }
    assertPlaceholdersResolvable(content, parsed.images?.length ?? 0, parsed.files?.length ?? 0);
  }

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
    utcDateModified: parsed.utcDateModified,
  });
  const noteId = result.note.noteId;

  // The note exists from here on: any failure must say so, or the caller
  // would retry and create a duplicate.
  const urlFor = () => client.getNoteUrl(noteId, result.branch.parentNoteId);
  const partialFailure = async (what: string, error: unknown, extra: object = {}) => ({
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error:
              `Note ${noteId} was created, but ${what} failed: ` +
              `${error instanceof Error ? error.message : String(error)}. Do NOT retry create_note — ` +
              'fix the existing note with write_note / create_attachment.',
            noteId,
            url: await urlFor(),
            ...extra,
          },
          null,
          2
        ),
      },
    ],
  });

  try {
    if (binaryContent && binaryContent.length > 0) {
      await client.updateNoteContentBinary(noteId, binaryContent);
    }
  } catch (error) {
    return partialFailure('uploading its binary content', error);
  }

  let warning: string | undefined;
  if (staged.length > 0) {
    let uploaded: UploadedAttachment[];
    try {
      uploaded = await uploadStaged(client, noteId, staged);
    } catch (error) {
      const done = error instanceof AttachmentUploadError ? describeUploads(error.uploaded) : [];
      return partialFailure('uploading attachments', error, { uploadedAttachments: done });
    }
    // For a binary note the body IS the blob — writing HTML would overwrite it.
    if (!isBinary) {
      content = substituteAttachmentPlaceholders(content, uploaded);
      assertPlaceholdersResolved(content);
      try {
        await client.updateNoteContent(noteId, content);
      } catch (error) {
        return partialFailure('writing the content that embeds its attachments', error, {
          uploadedAttachments: describeUploads(uploaded),
        });
      }
    }
  } else if (isText && needsLinkIndexing(content)) {
    // Re-save so Trilium indexes the links (backlinks, note map); see needsLinkIndexing.
    try {
      await client.updateNoteContent(noteId, content);
      if (parsed.utcDateModified) {
        // The re-save stamped "now" — put the requested modified date back.
        await client.updateNote(noteId, { utcDateModified: parsed.utcDateModified });
      }
    } catch (error) {
      warning =
        'Note created, but re-saving it so Trilium indexes its links failed ' +
        `(${error instanceof Error ? error.message : String(error)}). The links work, but may not ` +
        'appear in backlinks/note map until the note is next edited. Do NOT re-create the note.';
    }
  }

  const url = await urlFor();
  return textResult({
    note: result.note,
    branch: result.branch,
    url,
    ...(warning ? { warning } : {}),
  });
}

async function getNote(client: TriliumClient, args: unknown): Promise<ToolHandlerResult> {
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
    return textResult(meta);
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
      `Call get_note again with content_start=${end} to continue.`;
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

  const out: ToolContentBlock[] = [{ type: 'text', text: JSON.stringify(metaBlock, null, 2) }];

  // Attachments ride along with the first page only; later pages are text.
  if (!parsed.includeImages || parsed.content_start !== 0) {
    out.push({ type: 'text', text: textContent });
    return { content: out };
  }

  const attachments = await client.getNoteAttachments(parsed.noteId);
  // Only images the body actually embeds (its HTML carries the attachment ID).
  const embedded = attachments.filter(
    (a) => isImageMimeType(a.mime) && rawHtml.includes(a.attachmentId)
  );
  const others = attachments.filter((a) => !embedded.includes(a));

  const images: Array<{ data: string; mimeType: string }> = [];
  const skipped: Array<{ attachmentId: string; title: string; sizeBytes: number }> = [];
  const failed: string[] = [];
  let totalBytes = 0;
  for (const a of embedded) {
    const declared = a.contentLength ?? 0;
    if (declared > IMAGE_MAX_BYTES || totalBytes + declared > IMAGES_TOTAL_MAX_BYTES) {
      skipped.push({ attachmentId: a.attachmentId, title: a.title, sizeBytes: declared });
      continue;
    }
    try {
      const data = await client.getAttachmentContentAsBase64(a.attachmentId);
      // contentLength may be absent or stale; trust whichever is larger.
      const sizeBytes = Math.max(declared, Math.floor((data.length * 3) / 4));
      if (sizeBytes > IMAGE_MAX_BYTES || totalBytes + sizeBytes > IMAGES_TOTAL_MAX_BYTES) {
        skipped.push({ attachmentId: a.attachmentId, title: a.title, sizeBytes });
        continue;
      }
      totalBytes += sizeBytes;
      images.push({ data, mimeType: a.mime });
    } catch (error) {
      failed.push(`- ${a.attachmentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let finalText = textContent;
  if (others.length > 0) {
    const list = others
      .map((a) => `- **${a.title || a.attachmentId}** (${a.mime}) - ID: \`${a.attachmentId}\``)
      .join('\n');
    finalText +=
      `\n\n---\n**Attachments:** ${others.length} attachment(s) not shown inline; fetch with ` +
      `get_attachment:\n${list}`;
  }
  if (skipped.length > 0) {
    finalText +=
      '\n\n---\n**Images not inlined (size limit):** fetch with get_attachment if needed:\n' +
      JSON.stringify(skipped);
  }
  if (failed.length > 0) {
    finalText += `\n\n---\n**Note:** Some images could not be loaded:\n${failed.join('\n')}`;
  }

  out.push({ type: 'text', text: finalText });
  for (const img of images) {
    out.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  }
  return { content: out };
}

async function writeNote(client: TriliumClient, args: unknown): Promise<ToolHandlerResult> {
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
    return textResult({ ...result, url });
  }

  const target = await client.getNote(parsed.noteId);
  const isText = target.type === 'text';
  const hasAttachments = (parsed.images?.length ?? 0) > 0 || (parsed.files?.length ?? 0) > 0;

  if (isBinaryMimeType(target.mime)) {
    if (parsed.mode !== 'replace') {
      throw new Error(
        `Note ${parsed.noteId} is a binary ${target.type} note (${target.mime}); mode="${parsed.mode}" ` +
          'only works on text content. Use mode="replace" with a file path, URL, data URL or base64.'
      );
    }
    if (hasAttachments) {
      throw new Error(
        'images/files cannot be embedded in a binary note; attach them with create_attachment instead.'
      );
    }
    const resolved = await resolveContentInput(required(parsed.content, 'content'), {
      mime: target.mime,
      filename: target.title,
    });
    await client.updateNoteContentBinary(parsed.noteId, resolved.buffer);
    const url = await client.getNoteUrl(parsed.noteId);
    return textResult({ success: true, noteId: parsed.noteId, mode: parsed.mode, url });
  }

  // Resolve image/file inputs before writing anything.
  const staged = await stageAttachments(parsed.images, parsed.files);
  const toHtml = async (c: string) =>
    isText && parsed.format === 'markdown' ? await marked.parse(c) : c;

  let finalContent: string;
  let appliedChanges = parsed.changes;
  if (parsed.mode === 'replace') {
    finalContent = await toHtml(required(parsed.content, 'content'));
  } else if (parsed.mode === 'append') {
    const existing = await client.getNoteContent(parsed.noteId);
    finalContent = existing + (await toHtml(required(parsed.content, 'content')));
  } else {
    const existing = await client.getNoteContent(parsed.noteId);
    // Resolve note: placeholders inside each new_string up front, so the
    // read-back verification below checks for the text actually written.
    if (isText && appliedChanges?.some((c) => hasNoteLinkPlaceholders(c.new_string))) {
      appliedChanges = await Promise.all(
        appliedChanges.map(async (c) => ({
          ...c,
          new_string: await resolveNoteLinks(client, c.new_string),
        }))
      );
    }
    finalContent = await resolveContent(existing, {
      changes: appliedChanges,
      patch: parsed.patch,
    });
  }

  // Only text notes hold HTML links; a code note may legitimately contain the literal string.
  if (isText && hasNoteLinkPlaceholders(finalContent)) {
    finalContent = await resolveNoteLinks(client, finalContent);
  }

  if (staged.length > 0) {
    assertPlaceholdersResolvable(
      finalContent,
      parsed.images?.length ?? 0,
      parsed.files?.length ?? 0
    );
    let uploaded: UploadedAttachment[];
    try {
      uploaded = await uploadStaged(client, parsed.noteId, staged);
    } catch (error) {
      const done = error instanceof AttachmentUploadError ? describeUploads(error.uploaded) : [];
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error:
                  `${error instanceof Error ? error.message : String(error)}. The note content was NOT ` +
                  'changed, but the attachments listed in uploadedAttachments were created on the note. ' +
                  'Do not retry blindly: reference those via their real URLs (or delete them with ' +
                  'delete_attachment) and fix the failing input.',
                noteId: parsed.noteId,
                uploadedAttachments: done,
              },
              null,
              2
            ),
          },
        ],
      };
    }
    finalContent = substituteAttachmentPlaceholders(finalContent, uploaded);
  }

  assertPlaceholdersResolved(finalContent);
  await client.updateNoteContent(parsed.noteId, finalContent);

  if (parsed.mode === 'edit' && appliedChanges !== undefined) {
    const readBack = await client.getNoteContent(parsed.noteId);
    verifySearchReplaceResults(readBack, appliedChanges, finalContent);
  }

  const url = await client.getNoteUrl(parsed.noteId);
  return textResult({ success: true, noteId: parsed.noteId, mode: parsed.mode, url });
}

export async function handleNoteTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<ToolHandlerResult> {
  switch (name) {
    case 'create_note':
      return createNote(client, args);

    case 'get_note':
      return getNote(client, args);

    case 'write_note':
      return writeNote(client, args);

    case 'delete_note': {
      const parsed = deleteNoteSchema.parse(args);
      if (parsed.action === 'delete') {
        await client.deleteNote(parsed.noteId);
        return textResult({ success: true, noteId: parsed.noteId, action: 'delete' });
      }
      return textResult(await client.undeleteNote(parsed.noteId));
    }

    case 'get_note_history': {
      const parsed = getNoteHistorySchema.parse(args);
      const history = await client.getNoteHistory(parsed.ancestorNoteId);
      const changes = history.slice(0, parsed.limit);
      return textResult({
        changes,
        total: history.length,
        returned: changes.length,
        truncated: changes.length < history.length,
      });
    }

    default:
      return null;
  }
}
