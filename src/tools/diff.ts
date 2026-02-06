import { z } from 'zod';
import { applyPatch } from 'diff';

/**
 * Zod schema for a single search/replace block.
 */
export const searchReplaceBlockSchema = z.object({
  old_string: z.string().describe('The exact string to find in the existing content'),
  new_string: z.string().describe('The replacement string'),
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
        `Search/replace failed: could not find the search string in content. ` +
          `Search string: "${old_string.length > 100 ? old_string.slice(0, 100) + '...' : old_string}"`
      );
    }

    const secondIndex = result.indexOf(old_string, firstIndex + 1);
    if (secondIndex !== -1) {
      throw new DiffApplicationError(
        `Search/replace failed: the search string is ambiguous (appears multiple times in content). ` +
          `Search string: "${old_string.length > 100 ? old_string.slice(0, 100) + '...' : old_string}"`
      );
    }

    result = result.slice(0, firstIndex) + new_string + result.slice(firstIndex + old_string.length);
  }

  return result;
}

/**
 * Apply a unified diff patch to content.
 * Wraps diff.applyPatch() and throws DiffApplicationError if the patch fails.
 */
export function applyUnifiedDiff(content: string, patch: string): string {
  const result = applyPatch(content, patch);
  if (result === false) {
    throw new DiffApplicationError(
      'Unified diff failed: the patch could not be applied to the current content. ' +
        'The content may have changed since the patch was created. ' +
        'Fetch the current content and retry with updated diffs.'
    );
  }
  return result;
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
