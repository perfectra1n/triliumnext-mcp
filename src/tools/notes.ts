import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  TriliumClientError,
  TriliumResponseTooLargeError,
  type TriliumClient,
} from '../client/trilium.js';
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
  isBinaryNote,
  resolveContentInput,
  getContentInputPolicy,
  ContentNormalizationError,
  CONTENT_SOURCE_GUIDANCE,
} from './contentInput.js';
import { createAttachmentWithContent, OrphanedAttachmentError } from './attachments.js';
import { searchReplaceBlockSchema, resolveContent, verifySearchReplaceResults } from './diff.js';
import { base64DecodedLength, formatMegabytes, getContentCharCap } from './contentLimits.js';
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

/**
 * Hard bound on images (and, separately, files) per create_note/write_note
 * call. Their combined size is also capped; see stageAttachments.
 */
export const MAX_ATTACHMENTS_PER_CALL = 50;

const imagesFieldSchema = z
  .array(imageEntrySchema)
  .max(MAX_ATTACHMENTS_PER_CALL, `At most ${MAX_ATTACHMENTS_PER_CALL} images per call`)
  .optional()
  .describe(
    'Images to upload as attachments of this note and embed. Reference entry N from the content with ' +
      '<img src="image:N"> (HTML, double quotes) or ![alt](image:N) (markdown); N indexes THIS array only, ' +
      'not attachments from earlier calls. Unreferenced images are appended at the end; an unresolved ' +
      'placeholder fails the call. To embed an existing attachment use its real URL: ' +
      '<img src="api/attachments/{attachmentId}/image/{filename}">. Images and files together may ' +
      "total at most the server's per-input content limit; add more with create_attachment."
  );

const fileEntrySchema = z.object({
  data: z.string().describe('The file, in any of the forms images[].data accepts.'),
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
  .max(MAX_ATTACHMENTS_PER_CALL, `At most ${MAX_ATTACHMENTS_PER_CALL} files per call`)
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
 *
 * Inputs are resolved one at a time, and their combined size is bounded by the
 * same limit as a single input (TRILIUM_MAX_CONTENT_FETCH_BYTES): each fetch
 * may only use what is left of that budget, so one call can never buffer more
 * than one maximum-size input's worth of attachments.
 */
async function stageAttachments(
  images: EntryInput[] | undefined,
  files: EntryInput[] | undefined
): Promise<StagedAttachment[]> {
  const policy = getContentInputPolicy();
  const totalMax = policy.maxBytes;
  const entries = [
    ...(images ?? []).map((entry, index) => ({ entry, index, role: 'image' as const })),
    ...(files ?? []).map((entry, index) => ({ entry, index, role: 'file' as const })),
  ];
  const staged: StagedAttachment[] = [];
  let totalBytes = 0;
  for (const { entry, index, role } of entries) {
    const remaining = totalMax - totalBytes;
    const overBudget = (): ContentNormalizationError =>
      new ContentNormalizationError(
        'INPUT_TOO_LARGE',
        `${role}:${index} does not fit: the images/files of one call may total at most ` +
          `${totalMax} bytes, and ${totalBytes} bytes are already used by earlier entries. Nothing was written.`,
        'Upload fewer or smaller attachments per call (add the rest with create_attachment), or raise ' +
          '--max-content-fetch-bytes.'
      );
    if (remaining <= 0) throw overBudget();
    let resolved: Awaited<ReturnType<typeof resolveContentInput>>;
    try {
      resolved = await resolveContentInput(
        entry.data,
        { mime: entry.mime, filename: entry.filename },
        remaining < policy.maxBytes ? { ...policy, maxBytes: remaining } : undefined
      );
    } catch (error) {
      // Over the shrunken per-call budget but within the per-input limit:
      // explain the real reason instead of quoting the shrunken limit.
      if (
        error instanceof ContentNormalizationError &&
        error.code === 'INPUT_TOO_LARGE' &&
        remaining < policy.maxBytes
      ) {
        throw overBudget();
      }
      throw error;
    }
    totalBytes += resolved.buffer.length;
    staged.push({
      role,
      index,
      title:
        entry.filename ?? resolved.sourceName ?? defaultAttachmentName(role, index, resolved.mime),
      mime: resolved.mime,
      // Images always go up as raw bytes; files follow their MIME type.
      isBinary: role === 'image' || resolved.isBinary,
      buffer: resolved.buffer,
    });
  }
  return staged;
}

interface UploadedAttachment {
  staged: StagedAttachment;
  attachment: Attachment;
}

interface AttachmentUploadFailure {
  staged: StagedAttachment;
  error: string;
  /** Set when an empty attachment was left behind and could not be deleted. */
  orphanedAttachmentId?: string;
}

/** Thrown when some staged attachments could not be uploaded. */
class AttachmentUploadError extends Error {
  constructor(
    public readonly uploaded: UploadedAttachment[],
    public readonly failures: AttachmentUploadFailure[]
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
  const uploaded: UploadedAttachment[] = [];
  const failures: AttachmentUploadFailure[] = [];
  // One at a time: Trilium serializes writes anyway, and a burst of parallel
  // uploads only competes with other clients for its single database.
  for (const item of staged) {
    try {
      const attachment = await createAttachmentWithContent(client, {
        ownerId,
        role: item.role,
        mime: item.mime,
        title: item.title,
        isBinary: item.isBinary,
        buffer: item.buffer,
      });
      uploaded.push({ staged: item, attachment });
    } catch (error) {
      failures.push({
        staged: item,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof OrphanedAttachmentError
          ? { orphanedAttachmentId: error.attachmentId }
          : {}),
      });
    }
  }
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
        'source. Binary notes (file/image with a binary mime): a path, URL, data URL or base64, in ' +
        'the forms images[].data accepts. ' +
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

/** get_note inlines embedded images only up to these sizes (per image / per call). */
export const DEFAULT_NOTE_IMAGE_MAX_BYTES = 1024 * 1024;
export const DEFAULT_NOTE_IMAGES_TOTAL_MAX_BYTES = 4 * 1024 * 1024;
/** Default ceiling for get_note's content_max_chars parameter. */
export const DEFAULT_CONTENT_MAX_CHARS_LIMIT = 500_000;
/** Bound the ancestor walks / backlink scan one get_note call can trigger. */
export const DEFAULT_MAX_PATHS = 10;
export const DEFAULT_MAX_BACKLINKS = 50;
/** get_note_history page size: default and ceiling of its `limit` parameter. */
export const DEFAULT_HISTORY_LIMIT = 100;
export const DEFAULT_HISTORY_MAX_LIMIT = 1000;

export interface NoteToolLimits {
  noteImageMaxBytes: number;
  noteImagesTotalMaxBytes: number;
  contentMaxCharsLimit: number;
  maxPaths: number;
  maxBacklinks: number;
  historyLimit: number;
  historyMaxLimit: number;
}

const DEFAULT_NOTE_LIMITS: NoteToolLimits = {
  noteImageMaxBytes: DEFAULT_NOTE_IMAGE_MAX_BYTES,
  noteImagesTotalMaxBytes: DEFAULT_NOTE_IMAGES_TOTAL_MAX_BYTES,
  contentMaxCharsLimit: DEFAULT_CONTENT_MAX_CHARS_LIMIT,
  maxPaths: DEFAULT_MAX_PATHS,
  maxBacklinks: DEFAULT_MAX_BACKLINKS,
  historyLimit: DEFAULT_HISTORY_LIMIT,
  historyMaxLimit: DEFAULT_HISTORY_MAX_LIMIT,
};

let limits: NoteToolLimits = { ...DEFAULT_NOTE_LIMITS };

// The get_note / get_note_history schemas interpolate limits into defaults,
// bounds and descriptions, so they are rebuilt whenever the limits change.
function buildGetNoteSchema() {
  const charCap = getContentCharCap();
  return z.object({
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
          `(content_start=0), at most ~${formatMegabytes(limits.noteImageMaxBytes)} each and ` +
          `~${formatMegabytes(limits.noteImagesTotalMaxBytes)} total; larger ones are listed for ` +
          'get_attachment. Also controls whether an image NOTE (type image) returns its picture. ' +
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
      .max(
        limits.contentMaxCharsLimit,
        `content_max_chars cannot exceed ${limits.contentMaxCharsLimit}`
      )
      .default(Math.min(charCap, limits.contentMaxCharsLimit))
      .describe(
        `Maximum content characters to return (default ${Math.min(charCap, limits.contentMaxCharsLimit)}). ` +
          'When the note is larger, the content is truncated with a notice explaining how to fetch the rest.'
      ),
    include_path: z
      .boolean()
      .default(false)
      .describe(
        'Add "paths" to the metadata: for every place the note sits in the tree (one per parent, clones ' +
          'included), the noteId path and a human-readable title breadcrumb like "root > Projects > Plan". ' +
          `Use it to tell the user WHERE a note lives. At most ${limits.maxPaths} paths; ` +
          'pathsTruncated:true marks a note with more placements.'
      ),
    include_backlinks: z
      .boolean()
      .default(false)
      .describe(
        'Add "backlinks" to the metadata: notes whose content links to (or mentions the ID of) this note, ' +
          `with noteId and title (max ${limits.maxBacklinks}; backlinksTruncated:true when there are more). ` +
          'Relations without a link in the content (e.g. ~author) are not included. This is a slow ' +
          'full-text scan of every note body; if Trilium is busy or it times out, the note is still ' +
          'returned, with backlinksError instead of backlinks.'
      ),
  });
}

let getNoteSchema = buildGetNoteSchema();

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

function buildGetNoteHistorySchema() {
  return z.object({
    ancestorNoteId: entityIdSchema
      .optional()
      .describe('Limit changes to a subtree identified by this note ID. Defaults to all notes.'),
    limit: z
      .number()
      .int('limit must be an integer')
      .min(1, 'limit must be at least 1')
      .max(limits.historyMaxLimit, `limit cannot exceed ${limits.historyMaxLimit}`)
      .default(Math.min(limits.historyLimit, limits.historyMaxLimit))
      .describe(
        'Maximum number of changes to return, newest first (default ' +
          `${Math.min(limits.historyLimit, limits.historyMaxLimit)}, max ${limits.historyMaxLimit}).`
      ),
  });
}

let getNoteHistorySchema = buildGetNoteHistorySchema();

/**
 * Process-wide note-tool limits. Called once at startup, after
 * configureContentLimits and before tools are registered; unset fields keep
 * their defaults.
 */
export function configureNoteTools(options: Partial<NoteToolLimits>): void {
  limits = { ...DEFAULT_NOTE_LIMITS };
  for (const [key, value] of Object.entries(options) as Array<[keyof NoteToolLimits, number]>) {
    if (value !== undefined) limits[key] = value;
  }
  getNoteSchema = buildGetNoteSchema();
  getNoteHistorySchema = buildGetNoteHistorySchema();
}

// ============================================================================
// Note context helpers
// ============================================================================

type NoteMeta = Awaited<ReturnType<TriliumClient['getNote']>>;

/** One breadcrumb per tree placement (clones have several), at most maxPaths. */
async function buildNotePaths(
  client: TriliumClient,
  note: NoteMeta
): Promise<{ paths: Array<{ path: string; breadcrumb: string }>; truncated: boolean }> {
  const titles = new Map<string, string>([[note.noteId, note.title]]);
  const titleOf = async (id: string): Promise<string> => {
    const cached = titles.get(id);
    if (cached !== undefined) return cached;
    const title = id === 'root' ? 'root' : (await client.getNote(id)).title;
    titles.set(id, title);
    return title;
  };

  const allParents = note.noteId === 'root' ? [undefined] : note.parentNoteIds;
  const parents = allParents.slice(0, limits.maxPaths);
  const paths = await Promise.all(
    parents.map(async (parentId) => {
      const path = await client.getNotePath(note.noteId, parentId);
      const crumbs = await Promise.all(path.split('/').map(titleOf));
      return { path, breadcrumb: crumbs.join(' > ') };
    })
  );
  return { paths, truncated: allParents.length > parents.length };
}

async function findBacklinks(
  client: TriliumClient,
  noteId: string
): Promise<{ backlinks: Array<{ noteId: string; title: string }>; truncated: boolean }> {
  // Trilium has no "any relation pointing here" query, but every in-content link
  // carries the target's noteId (href/data-note-path), so a content scan for the
  // ID finds links regardless of whether Trilium has indexed them as relations.
  // Over-fetch by two: the note itself may be among the hits.
  const response = await client.searchNotes({
    search: `note.content *=* "${noteId}"`,
    limit: limits.maxBacklinks + 2,
  });
  const others = response.results.filter((n) => n.noteId !== noteId);
  return {
    backlinks: others
      .slice(0, limits.maxBacklinks)
      .map((n) => ({ noteId: n.noteId, title: n.title })),
    truncated: others.length > limits.maxBacklinks,
  };
}

/**
 * The backlink scan reads every note body, so on a large Trilium it can time
 * out or find Trilium busy. That must not cost the caller the note itself.
 */
async function findBacklinksOrError(
  client: TriliumClient,
  noteId: string
): Promise<Record<string, unknown>> {
  try {
    const { backlinks, truncated } = await findBacklinks(client, noteId);
    return { backlinks, ...(truncated ? { backlinksTruncated: true } : {}) };
  } catch (error) {
    if (
      error instanceof TriliumClientError &&
      (error.code === 'TRILIUM_BUSY' || error.code === 'TRILIUM_TIMEOUT')
    ) {
      return {
        backlinksError:
          `The backlink scan (a full-text search over all note bodies) did not finish: ${error.message} ` +
          'The rest of the note is complete; retry include_backlinks later if you still need it.',
      };
    }
    throw error;
  }
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
        `${getContentCharCap()} characters are paged via content_start/content_max_chars. ` +
        'Pass include_content=false for metadata only, include_path=true for breadcrumbs of where the ' +
        'note lives, include_backlinks=true for notes linking to it (a slow scan of all note bodies).',
      getNoteSchema,
      { title: 'Read note', readOnlyHint: true, openWorldHint: false }
    ),
    defineTool(
      'get_note_history',
      'Get recent changes across the note tree — creations, modifications, and deletions. Optionally filter by subtree via ancestorNoteId. ' +
        'Returns {changes, total, returned, truncated}; pass limit (default ' +
        `${Math.min(limits.historyLimit, limits.historyMaxLimit)}) to see more. ` +
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

/** Attachments a failed upload batch left behind as empty records (delete failed too). */
const describeOrphans = (error: unknown) =>
  error instanceof AttachmentUploadError
    ? error.failures
        .filter((f) => f.orphanedAttachmentId !== undefined)
        .map((f) => ({
          placeholder: `${f.staged.role}:${f.staged.index}`,
          attachmentId: f.orphanedAttachmentId,
        }))
    : [];

async function createNote(client: TriliumClient, args: unknown): Promise<ToolHandlerResult> {
  const parsed = createNoteSchema.parse(args);
  // Same rule Trilium uses: code/text/... notes are strings whatever their
  // mime ("application/javascript;env=frontend"); only file/image-like notes
  // with a binary mime carry bytes.
  const isBinary = isBinaryNote(parsed.type, parsed.mime);
  const isText = parsed.type === 'text';

  // Resolve every input BEFORE creating anything, so a bad path/URL/base64
  // fails the call without leaving a half-built note behind. Binary content
  // is normalized before any format conversion (markdown would corrupt it).
  // Sequential, so the body and the attachments are never all buffered at once
  // mid-fetch.
  const binaryContent = isBinary
    ? (await resolveContentInput(parsed.content, { mime: parsed.mime, filename: parsed.title }))
        .buffer
    : null;
  const staged = await stageAttachments(parsed.images, parsed.files);

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

  // Any write after the create stamps "now" as the modified date.
  let wroteAfterCreate = false;
  try {
    if (binaryContent && binaryContent.length > 0) {
      wroteAfterCreate = true;
      await client.updateNoteContentBinary(noteId, binaryContent);
    }
  } catch (error) {
    return partialFailure('uploading its binary content', error);
  }

  const warnings: string[] = [];
  if (staged.length > 0) {
    let uploaded: UploadedAttachment[];
    wroteAfterCreate = true;
    try {
      uploaded = await uploadStaged(client, noteId, staged);
    } catch (error) {
      const done = error instanceof AttachmentUploadError ? describeUploads(error.uploaded) : [];
      const orphans = describeOrphans(error);
      return partialFailure('uploading attachments', error, {
        uploadedAttachments: done,
        ...(orphans.length > 0 ? { orphanedAttachments: orphans } : {}),
      });
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
      wroteAfterCreate = true;
      await client.updateNoteContent(noteId, content);
    } catch (error) {
      warnings.push(
        'Note created, but re-saving it so Trilium indexes its links failed ' +
          `(${error instanceof Error ? error.message : String(error)}). The links work, but may not ` +
          'appear in backlinks/note map until the note is next edited. Do NOT re-create the note.'
      );
    }
  }

  if (wroteAfterCreate && parsed.utcDateModified) {
    // The follow-up writes stamped "now" — put the requested modified date back.
    try {
      await client.updateNote(noteId, { utcDateModified: parsed.utcDateModified });
    } catch (error) {
      warnings.push(
        `Note created, but restoring utcDateModified=${parsed.utcDateModified} after the content ` +
          `upload failed (${error instanceof Error ? error.message : String(error)}). Set it with ` +
          'write_note {mode:"metadata", utcDateModified}. Do NOT re-create the note.'
      );
    }
  }
  const warning = warnings.length > 0 ? warnings.join(' ') : undefined;

  const url = await urlFor();
  return textResult({
    note: result.note,
    branch: result.branch,
    url,
    ...(warning ? { warning } : {}),
  });
}

/**
 * Body of a binary (file/image) note. Its bytes are not text, so decoding them
 * as a string would only waste memory and context: an image note within the
 * per-image cap comes back as an image block; anything else gets a notice.
 */
async function getBinaryNoteContent(
  client: TriliumClient,
  note: NoteMeta,
  meta: Record<string, unknown>,
  includeImages: boolean
): Promise<ToolHandlerResult> {
  const notice = (
    reason: string,
    next = 'Do not retry; have the user open the note in Trilium.'
  ): ToolHandlerResult => ({
    content: [
      { type: 'text', text: JSON.stringify({ ...meta, contentInfo: { binary: true } }, null, 2) },
      { type: 'text', text: `**Content not returned:** ${reason} ${next}` },
    ],
  });
  const kind = `binary ${note.type} note (${note.mime || 'no mime'})`;
  if (!isImageMimeType(note.mime)) {
    return notice(`this is a ${kind}, so its content is not readable as text.`);
  }
  if (!includeImages) {
    return notice(
      `this is an ${kind} and includeImages=false was passed.`,
      'Call get_note again with includeImages=true to see the image.'
    );
  }
  const maxBytes = limits.noteImageMaxBytes;
  let bytes: Buffer;
  try {
    bytes = await client.getNoteContentBinary(note.noteId, maxBytes);
  } catch (error) {
    if (error instanceof TriliumResponseTooLargeError) {
      return notice(
        `this ${kind} is at least ${error.sizeBytes} bytes, over the ${maxBytes}-byte limit, so it is too large to inline here.`
      );
    }
    throw error;
  }
  if (bytes.length > maxBytes) {
    return notice(
      `this ${kind} is ${bytes.length} bytes, over the ${maxBytes}-byte limit, so it is too large to inline here.`
    );
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { ...meta, contentInfo: { binary: true, sizeBytes: bytes.length } },
          null,
          2
        ),
      },
      { type: 'image', data: bytes.toString('base64'), mimeType: note.mime },
    ],
  };
}

async function getNote(client: TriliumClient, args: unknown): Promise<ToolHandlerResult> {
  const parsed = getNoteSchema.parse(args);
  const note = await client.getNote(parsed.noteId);
  const [paths, backlinks] = await Promise.all([
    parsed.include_path ? buildNotePaths(client, note) : undefined,
    parsed.include_backlinks ? findBacklinksOrError(client, note.noteId) : undefined,
  ]);
  const meta = {
    ...note,
    ...(paths ? { paths: paths.paths, ...(paths.truncated ? { pathsTruncated: true } : {}) } : {}),
    ...(backlinks ?? {}),
  };

  if (!parsed.include_content) {
    return textResult(meta);
  }

  if (isBinaryNote(note.type, note.mime)) {
    return getBinaryNoteContent(client, note, meta, parsed.includeImages);
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
  const { noteImageMaxBytes, noteImagesTotalMaxBytes } = limits;
  let totalBytes = 0;
  // Sequential on purpose: each image is held as bytes plus a base64 copy, so
  // fetching them in parallel would multiply peak memory.
  for (const a of embedded) {
    const declared = a.contentLength ?? 0;
    if (declared > noteImageMaxBytes || totalBytes + declared > noteImagesTotalMaxBytes) {
      skipped.push({ attachmentId: a.attachmentId, title: a.title, sizeBytes: declared });
      continue;
    }
    try {
      // The client stops reading past this budget, so an image whose declared
      // size lied is never buffered whole.
      const budget = Math.min(noteImageMaxBytes, noteImagesTotalMaxBytes - totalBytes);
      const data = await client.getAttachmentContentAsBase64(a.attachmentId, budget);
      // contentLength may be absent or stale; trust whichever is larger.
      const sizeBytes = Math.max(declared, base64DecodedLength(data));
      if (sizeBytes > noteImageMaxBytes || totalBytes + sizeBytes > noteImagesTotalMaxBytes) {
        skipped.push({ attachmentId: a.attachmentId, title: a.title, sizeBytes });
        continue;
      }
      totalBytes += sizeBytes;
      images.push({ data, mimeType: a.mime });
    } catch (error) {
      if (error instanceof TriliumResponseTooLargeError) {
        skipped.push({ attachmentId: a.attachmentId, title: a.title, sizeBytes: error.sizeBytes });
        continue;
      }
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

  if (isBinaryNote(target.type, target.mime)) {
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

  let uploaded: UploadedAttachment[] = [];
  if (staged.length > 0) {
    assertPlaceholdersResolvable(
      finalContent,
      parsed.images?.length ?? 0,
      parsed.files?.length ?? 0
    );
    try {
      uploaded = await uploadStaged(client, parsed.noteId, staged);
    } catch (error) {
      const done = error instanceof AttachmentUploadError ? describeUploads(error.uploaded) : [];
      const orphans = describeOrphans(error);
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
                ...(orphans.length > 0 ? { orphanedAttachments: orphans } : {}),
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
  try {
    await client.updateNoteContent(parsed.noteId, finalContent);
  } catch (error) {
    if (uploaded.length === 0) throw error;
    // The attachments exist now even though the content does not reference
    // them; say so, or a retry would upload every one of them again.
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error:
                `Writing the note content failed: ${error instanceof Error ? error.message : String(error)}. ` +
                'The attachments listed in uploadedAttachments WERE created on the note but are not ' +
                'referenced by its content. Do not re-send images/files: retry the write referencing ' +
                'them by their real URLs (api/attachments/{attachmentId}/image/{title} or ' +
                '.../download), or delete them with delete_attachment.',
              noteId: parsed.noteId,
              uploadedAttachments: describeUploads(uploaded),
            },
            null,
            2
          ),
        },
      ],
    };
  }

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
