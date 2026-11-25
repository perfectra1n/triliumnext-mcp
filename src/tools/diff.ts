import { z } from 'zod';
import { applyPatch } from 'diff';

/**
 * Zod schema for a single search/replace block.
 */
export const searchReplaceBlockSchema = z.object({
  old_string: z
    .string()
    .describe(
      'Exact substring of the stored content; must occur exactly once ("" = insert at start)'
    ),
  new_string: z.string().describe('Replacement text ("" deletes old_string)'),
});

export type SearchReplaceBlock = z.infer<typeof searchReplaceBlockSchema>;

/**
 * Custom error class for diff application failures.
 */
export class DiffApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffApplicationError';
  }
}

const preview = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + '...' : s);

/**
 * Apply a sequence of search/replace operations to content.
 * Each replacement is applied in order, so later replacements can depend on earlier ones.
 *
 * Throws DiffApplicationError if:
 * - A search string is not found in the current content
 * - A search string appears multiple times (ambiguous)
 *
 * Special case: empty old_string inserts new_string at the beginning of content.
 */
export function applySearchReplace(content: string, changes: SearchReplaceBlock[]): string {
  let result = content;

  for (const { old_string, new_string } of changes) {
    if (old_string === '') {
      // Empty old_string means insert at beginning
      result = new_string + result;
      continue;
    }

    const firstIndex = result.indexOf(old_string);
    if (firstIndex === -1) {
      throw new DiffApplicationError(
        `Search/replace failed (nothing was written): could not find old_string in the stored content. ` +
          `Search string: "${preview(old_string, 100)}"`
      );
    }

    const secondIndex = result.indexOf(old_string, firstIndex + 1);
    if (secondIndex !== -1) {
      throw new DiffApplicationError(
        `Search/replace failed (nothing was written): old_string is ambiguous — it appears more than once. ` +
          `Search string: "${preview(old_string, 100)}"`
      );
    }

    result =
      result.slice(0, firstIndex) + new_string + result.slice(firstIndex + old_string.length);
  }

  return result;
}

/**
 * Apply a unified diff patch to content.
 * Wraps diff.applyPatch() and throws DiffApplicationError if the patch is
 * malformed, spans several files, or does not apply.
 */
export function applyUnifiedDiff(content: string, patch: string): string {
  let result: string | false;
  try {
    result = applyPatch(content, patch);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DiffApplicationError(
      `Unified diff failed: the patch could not be parsed (${reason}). ` +
        'Provide a single-file unified diff with @@ hunk headers, or use "changes" ' +
        '(search/replace blocks), which is more reliable for Trilium HTML.'
    );
  }
  if (result === false) {
    throw new DiffApplicationError(
      'Unified diff failed: the patch could not be applied to the current content (nothing was written). ' +
        'Re-read the note with get_note (format="html") and rebuild the patch, or use "changes" ' +
        'instead — Trilium HTML is often a single long line, which makes line-based hunks fragile.'
    );
  }
  return result;
}

/**
 * Verify that search/replace changes were persisted. Each non-empty new_string
 * must appear in the read-back content; for a pure deletion (empty new_string)
 * whose old_string is absent from the content that was sent, old_string must
 * also be absent from the read-back.
 *
 * Throws DiffApplicationError if verification fails. The write has already
 * happened at this point, so the message says so and steers the caller to
 * re-read rather than blindly re-apply the same edit.
 */
export function verifySearchReplaceResults(
  readBackContent: string,
  changes: SearchReplaceBlock[],
  sentContent?: string
): void {
  const problems: string[] = [];
  for (const { old_string, new_string } of changes) {
    if (new_string !== '') {
      if (!readBackContent.includes(new_string)) {
        problems.push(`- replacement not found: "${preview(new_string, 200)}"`);
      }
    } else if (
      old_string !== '' &&
      sentContent !== undefined &&
      !sentContent.includes(old_string) &&
      readBackContent.includes(old_string)
    ) {
      problems.push(`- deleted text still present: "${preview(old_string, 200)}"`);
    }
  }

  if (problems.length > 0) {
    throw new DiffApplicationError(
      'The edit WAS written to Trilium, but read-back verification failed:\n' +
        problems.join('\n') +
        '\n\nTrilium probably normalized or sanitized the HTML. Do not re-apply the same edit: ' +
        'call get_note (format="html") to see what was actually saved, then make any follow-up ' +
        'edit against that content.'
    );
  }
}

/**
 * Unified entry point for resolving content from one of three modes:
 * - Full replacement: `content` is provided directly
 * - Search/replace: `changes` array is applied to existing content
 * - Unified diff: `patch` string is applied to existing content
 *
 * Optionally applies a conversion function (e.g., markdown to HTML) after resolving.
 */
export async function resolveContent(
  existingContent: string,
  input: { content?: string; changes?: SearchReplaceBlock[]; patch?: string },
  convertFn?: (content: string) => Promise<string>
): Promise<string> {
  let resolved: string;

  if (input.content !== undefined) {
    resolved = input.content;
  } else if (input.changes !== undefined) {
    resolved = applySearchReplace(existingContent, input.changes);
  } else if (input.patch !== undefined) {
    resolved = applyUnifiedDiff(existingContent, input.patch);
  } else {
    throw new DiffApplicationError(
      'No content mode specified: provide one of "content", "changes", or "patch".'
    );
  }

  if (convertFn) {
    resolved = await convertFn(resolved);
  }

  return resolved;
}
