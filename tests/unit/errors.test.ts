import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { TriliumClientError } from '../../src/client/trilium.js';
import {
  formatTriliumError,
  formatZodError,
  formatUnknownError,
  formatContentInputError,
  formatDiffError,
  formatErrorForMCP,
  type StructuredError,
} from '../../src/errors/index.js';
import { ContentNormalizationError } from '../../src/tools/contentInput.js';
import {
  DiffApplicationError,
  applySearchReplace,
  applyUnifiedDiff,
  verifySearchReplaceResults,
} from '../../src/tools/diff.js';
import { entityIdSchema } from '../../src/tools/validators.js';

describe('Error Formatting', () => {
  describe('formatTriliumError', () => {
    it('should format NOTE_NOT_FOUND with helpful suggestion', () => {
      const error = new TriliumClientError(404, 'NOTE_NOT_FOUND', "Note 'xyz123' not found");
      const result = formatTriliumError(error);

      expect(result.message).toBe("Note 'xyz123' not found");
      expect(result.status).toBe(404);
      expect(result.code).toBe('NOTE_NOT_FOUND');
      expect(result.suggestion).toContain('search_notes');
      expect(result.suggestion).toContain('valid note IDs');
    });

    it('should format NOTE_IS_PROTECTED with helpful suggestion', () => {
      const error = new TriliumClientError(403, 'NOTE_IS_PROTECTED', 'Note is protected');
      const result = formatTriliumError(error);

      expect(result.status).toBe(403);
      expect(result.code).toBe('NOTE_IS_PROTECTED');
      expect(result.suggestion).toContain('protected');
      expect(result.suggestion).toContain('unprotect');
    });

    it('should format BRANCH_NOT_FOUND with helpful suggestion', () => {
      const error = new TriliumClientError(404, 'BRANCH_NOT_FOUND', "Branch 'abc' not found");
      const result = formatTriliumError(error);

      expect(result.code).toBe('BRANCH_NOT_FOUND');
      expect(result.suggestion).toContain('get_note');
      expect(result.suggestion).toContain('branch IDs');
    });

    it('should format ATTRIBUTE_NOT_FOUND with helpful suggestion', () => {
      const error = new TriliumClientError(404, 'ATTRIBUTE_NOT_FOUND', "Attribute 'abc' not found");
      const result = formatTriliumError(error);

      expect(result.code).toBe('ATTRIBUTE_NOT_FOUND');
      expect(result.suggestion).toContain('get_attributes');
    });

    it('should fall back to status code guidance for unknown error codes', () => {
      const error = new TriliumClientError(401, 'UNKNOWN_CODE', 'Authentication failed');
      const result = formatTriliumError(error);

      expect(result.status).toBe(401);
      expect(result.code).toBe('UNKNOWN_CODE');
      expect(result.suggestion).toContain('Authentication');
    });

    it('omits the suggestion when there is nothing specific to say', () => {
      const error = new TriliumClientError(418, 'TEAPOT', "I'm a teapot");
      const result = formatTriliumError(error);

      expect(result.status).toBe(418);
      expect(result).not.toHaveProperty('suggestion');
      expect(formatErrorForMCP(result).content[0].text).not.toContain('Suggestion');
    });
  });

  describe('formatZodError', () => {
    it('should format missing required field errors', () => {
      const schema = z.object({
        noteId: z.string(),
        title: z.string(),
      });

      let zodError: z.ZodError | null = null;
      try {
        schema.parse({ noteId: 'test' }); // missing title
      } catch (e) {
        zodError = e as z.ZodError;
      }

      expect(zodError).not.toBeNull();
      const result = formatZodError(zodError!, 'create_note');

      expect(result.message).toBe('Invalid input for tool "create_note"');
      expect(result.fieldErrors).toBeDefined();
      expect(result.fieldErrors!['title']).toContain('Required');
      expect(result.suggestion).toContain('title');
    });

    it('should format invalid enum value errors', () => {
      const schema = z.object({
        type: z.enum(['text', 'code', 'file']),
      });

      let zodError: z.ZodError | null = null;
      try {
        schema.parse({ type: 'invalid' });
      } catch (e) {
        zodError = e as z.ZodError;
      }

      expect(zodError).not.toBeNull();
      const result = formatZodError(zodError!);

      expect(result.message).toBe('Invalid input');
      expect(result.fieldErrors!['type']).toContain('Allowed values');
      expect(result.fieldErrors!['type']).toContain('text');
      expect(result.fieldErrors!['type']).toContain('code');
      expect(result.fieldErrors!['type']).toContain('file');
    });

    it('should format type mismatch errors', () => {
      const schema = z.object({
        count: z.number(),
      });

      let zodError: z.ZodError | null = null;
      try {
        schema.parse({ count: 'not a number' });
      } catch (e) {
        zodError = e as z.ZodError;
      }

      expect(zodError).not.toBeNull();
      const result = formatZodError(zodError!);

      // Zod 4 includes "expected number" in the message
      expect(result.fieldErrors!['count']).toMatch(/number|Invalid/);
    });

    it('should handle multiple field errors', () => {
      const schema = z.object({
        noteId: z.string(),
        title: z.string(),
        type: z.enum(['text', 'code']),
      });

      let zodError: z.ZodError | null = null;
      try {
        schema.parse({ type: 'invalid' }); // missing noteId and title, invalid type
      } catch (e) {
        zodError = e as z.ZodError;
      }

      expect(zodError).not.toBeNull();
      const result = formatZodError(zodError!);

      expect(Object.keys(result.fieldErrors!).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('formatUnknownError', () => {
    it('should format Error instances', () => {
      const error = new Error('Something went wrong');
      const result = formatUnknownError(error);

      expect(result.message).toBe('Something went wrong');
      expect(result).not.toHaveProperty('suggestion');
    });

    it('should format string errors', () => {
      const result = formatUnknownError('String error message');

      expect(result.message).toBe('String error message');
    });

    it('should handle null/undefined', () => {
      const result = formatUnknownError(null);

      expect(result.message).toBe('null');
    });
  });

  describe('formatErrorForMCP', () => {
    it('should produce valid MCP response with all fields', () => {
      const structured: StructuredError = {
        message: 'Test error',
        status: 404,
        code: 'TEST_CODE',
        suggestion: 'Try this instead',
      };

      const result = formatErrorForMCP(structured);

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text;
      expect(text).toContain('**Error**: Test error');
      expect(text).toContain('**Status**: 404 (TEST_CODE)');
      expect(text).toContain('**Suggestion**: Try this instead');
    });

    it('should handle missing optional fields', () => {
      const structured: StructuredError = {
        message: 'Simple error',
      };

      const result = formatErrorForMCP(structured);

      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('**Error**: Simple error');
      expect(text).not.toContain('**Status**');
      expect(text).not.toContain('**Code**');
    });

    it('should handle status without code', () => {
      const structured: StructuredError = {
        message: 'Error with status only',
        status: 500,
      };

      const result = formatErrorForMCP(structured);

      const text = result.content[0].text;
      expect(text).toContain('**Status**: 500');
      expect(text).not.toContain('(');
    });

    it('should handle code without status', () => {
      const structured: StructuredError = {
        message: 'Error with code only',
        code: 'SOME_CODE',
      };

      const result = formatErrorForMCP(structured);

      const text = result.content[0].text;
      expect(text).toContain('**Code**: SOME_CODE');
    });

    it('should include field errors in suggestion', () => {
      const structured: StructuredError = {
        message: 'Validation error',
        suggestion: 'Fix these fields:\n  - field1: error1\n  - field2: error2',
        fieldErrors: {
          field1: 'error1',
          field2: 'error2',
        },
      };

      const result = formatErrorForMCP(structured);

      const text = result.content[0].text;
      expect(text).toContain('field1');
      expect(text).toContain('field2');
    });
  });
});

describe('formatContentInputError', () => {
  it('carries the code and suggestion through to the structured error', () => {
    const err = new ContentNormalizationError(
      'PATH_NOT_FOUND',
      'The input looks like a file path but no such file exists: /tmp/nope.png',
      'Check the path.'
    );
    const structured = formatContentInputError(err);
    expect(structured.message).toContain('/tmp/nope.png');
    expect(structured.code).toBe('PATH_NOT_FOUND');
    expect(structured.suggestion).toBe('Check the path.');
  });

  it('renders through formatErrorForMCP with a Suggestion block', () => {
    const err = new ContentNormalizationError('URL_BLOCKED', 'URL rejected.', 'Use a public URL.');
    const mcp = formatErrorForMCP(formatContentInputError(err));
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0].text).toContain('**Code**: URL_BLOCKED');
    expect(mcp.content[0].text).toContain('**Suggestion**: Use a public URL.');
  });
});

describe('formatZodError issue messages', () => {
  it('surfaces custom regex messages from validators verbatim', () => {
    const schema = z.object({ noteId: entityIdSchema });
    const result = schema.safeParse({ noteId: 'bad/id' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const formatted = formatZodError(result.error);
    expect(formatted.fieldErrors!['noteId']).toContain('letters, digits and underscores');
    expect(formatted.fieldErrors!['noteId']).not.toContain('Invalid format');
  });

  it('uses the zod message for too_small/too_big instead of assuming characters', () => {
    const schema = z.object({ depth: z.number().min(1), tags: z.array(z.string()).max(1) });
    const result = schema.safeParse({ depth: 0, tags: ['a', 'b'] });
    if (result.success) throw new Error('expected failure');
    const formatted = formatZodError(result.error);
    expect(formatted.fieldErrors!['depth']).not.toContain('characters');
    expect(formatted.fieldErrors!['depth']).toMatch(/>=\s*1/);
    expect(formatted.fieldErrors!['tags']).not.toContain('characters');
  });

  it('aggregates several issues on the same path', () => {
    const schema = z.object({
      name: z
        .string()
        .min(5, 'too short')
        .regex(/^[a-z]+$/, 'lowercase only'),
    });
    const result = schema.safeParse({ name: 'A1' });
    if (result.success) throw new Error('expected failure');
    const formatted = formatZodError(result.error);
    expect(formatted.fieldErrors!['name']).toBe('name: too short; lowercase only');
  });
});

describe('recovery hints', () => {
  it('branch hint points at the fields that actually carry branch IDs', () => {
    const s = formatTriliumError(new TriliumClientError(404, 'BRANCH_NOT_FOUND', 'x')).suggestion!;
    expect(s).toContain('parentBranchIds');
    expect(s).toContain('get_note_tree');
  });

  it('deleted-note hint explains how to restore', () => {
    const s = formatTriliumError(new TriliumClientError(400, 'NOTE_IS_DELETED', 'x')).suggestion!;
    expect(s).toContain('delete_note');
    expect(s).toContain('undelete');
  });

  it('auth errors tell the model not to retry', () => {
    for (const err of [
      new TriliumClientError(401, 'WHATEVER', 'x'),
      new TriliumClientError(401, 'ETAPI_TOKEN_INVALID', 'x'),
    ]) {
      const s = formatTriliumError(err).suggestion!;
      expect(s).toContain('do not retry');
      expect(s).toContain('tell the user');
    }
  });

  const diffError = (fn: () => unknown): DiffApplicationError => {
    try {
      fn();
    } catch (error) {
      if (error instanceof DiffApplicationError) return error;
      throw error;
    }
    throw new Error('expected a DiffApplicationError');
  };

  it('diff errors branch on not-found vs ambiguous (real errors)', () => {
    const notFound = formatDiffError(
      diffError(() => applySearchReplace('<p>a</p>', [{ old_string: 'zzz', new_string: 'y' }]))
    );
    expect(notFound.suggestion).toContain('format="html"');
    expect(notFound.suggestion).toContain('exact substring');

    const ambiguous = formatDiffError(
      diffError(() => applySearchReplace('<p>a a</p>', [{ old_string: 'a', new_string: 'b' }]))
    );
    expect(ambiguous.suggestion).toContain('unique');
  });

  it('does not misclassify from user text echoed in the message', () => {
    // old_string mentions "ambiguous", but the failure is not-found.
    const err = diffError(() =>
      applySearchReplace('<p>x</p>', [{ old_string: 'ambiguous could not find', new_string: '' }])
    );
    expect(err.kind).toBe('not_found');
    expect(formatDiffError(err).suggestion).toContain('exact substring');

    // A real ambiguity whose old_string says "could not find".
    const amb = diffError(() =>
      applySearchReplace('could not find, could not find', [
        { old_string: 'could not find', new_string: '' },
      ])
    );
    expect(amb.kind).toBe('ambiguous');
    expect(formatDiffError(amb).suggestion).toContain('unique');
  });

  it('classifies patch and verification failures', () => {
    const parseFail = diffError(() => applyUnifiedDiff('a\n', '--- a\n+++ b\n--- c\n+++ d\n'));
    expect(['patch_parse', 'patch_apply']).toContain(parseFail.kind);
    expect(formatDiffError(parseFail).suggestion).toContain('changes');

    const applyFail = diffError(() =>
      applyUnifiedDiff('x\n', '--- a\n+++ b\n@@ -1 +1 @@\n-nope\n+yes\n')
    );
    expect(applyFail.kind).toBe('patch_apply');

    const verify = diffError(() =>
      verifySearchReplaceResults('<p>other</p>', [{ old_string: 'a', new_string: 'b' }])
    );
    expect(verify.kind).toBe('verification');
    expect(formatDiffError(verify).suggestion).toContain('normalized');
  });

  it.each([
    ['TRILIUM_BUSY', 503, ['Wait']],
    ['TRILIUM_TIMEOUT', 504, ['create_note', 'search_notes', 'duplicate']],
    ['RESPONSE_TOO_LARGE', 413, ['Do not retry']],
    ['METRICS_UNSUPPORTED', 404, ['app_info']],
    ['EXPORT_TOO_LARGE', 413, ['smaller subtree']],
  ])('%s has specific guidance', (code, status, needles) => {
    const s = formatTriliumError(new TriliumClientError(status, code, 'x')).suggestion!;
    for (const needle of needles) expect(s).toContain(needle);
  });
});
