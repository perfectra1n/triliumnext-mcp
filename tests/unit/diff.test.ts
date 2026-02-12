import { describe, it, expect, vi } from 'vitest';
import {
  applySearchReplace,
  applyUnifiedDiff,
  resolveContent,
  verifySearchReplaceResults,
  DiffApplicationError,
} from '../../src/tools/diff.js';

describe('Diff Module', () => {
  describe('applySearchReplace', () => {
    it('should replace a single occurrence', () => {
      const result = applySearchReplace('<p>Hello World</p>', [
        { old_string: 'Hello', new_string: 'Goodbye' },
      ]);
      expect(result).toBe('<p>Goodbye World</p>');
    });

    it('should apply multiple sequential replacements', () => {
      const result = applySearchReplace('<p>Hello World, Hello Again</p>', [
        { old_string: 'Hello World', new_string: 'Goodbye World' },
        { old_string: 'Hello Again', new_string: 'Goodbye Again' },
      ]);
      expect(result).toBe('<p>Goodbye World, Goodbye Again</p>');
    });

    it('should handle deletion (empty new_string)', () => {
      const result = applySearchReplace('Hello World', [
        { old_string: ' World', new_string: '' },
      ]);
      expect(result).toBe('Hello');
    });

    it('should handle insertion at beginning (empty old_string)', () => {
      const result = applySearchReplace('World', [
        { old_string: '', new_string: 'Hello ' },
      ]);
      expect(result).toBe('Hello World');
    });

    it('should throw DiffApplicationError when search string not found', () => {
      expect(() =>
        applySearchReplace('<p>Hello</p>', [
          { old_string: 'nonexistent', new_string: 'x' },
        ])
      ).toThrow(DiffApplicationError);
      expect(() =>
        applySearchReplace('<p>Hello</p>', [
          { old_string: 'nonexistent', new_string: 'x' },
        ])
      ).toThrow('could not find');
    });

    it('should throw DiffApplicationError when search string is ambiguous (multiple matches)', () => {
      expect(() =>
        applySearchReplace('<p>Hello Hello</p>', [
          { old_string: 'Hello', new_string: 'x' },
        ])
      ).toThrow(DiffApplicationError);
      expect(() =>
        applySearchReplace('<p>Hello Hello</p>', [
          { old_string: 'Hello', new_string: 'x' },
        ])
      ).toThrow('ambiguous');
    });

    it('should handle special characters (HTML tags, entities, regex metacharacters)', () => {
      const result = applySearchReplace(
        '<p class="test">Price: $10.00 (USD)</p>',
        [{ old_string: '$10.00 (USD)', new_string: '$20.00 (EUR)' }]
      );
      expect(result).toBe('<p class="test">Price: $20.00 (EUR)</p>');
    });

    it('should handle multi-line old_string and new_string', () => {
      const content = 'line1\nline2\nline3';
      const result = applySearchReplace(content, [
        { old_string: 'line1\nline2', new_string: 'replaced1\nreplaced2' },
      ]);
      expect(result).toBe('replaced1\nreplaced2\nline3');
    });

    it('should apply sequential changes where later changes depend on earlier ones', () => {
      const result = applySearchReplace('AAABBB', [
        { old_string: 'AAA', new_string: 'CCC' },
        { old_string: 'CCCBBB', new_string: 'DONE' },
      ]);
      expect(result).toBe('DONE');
    });

    it('should handle large content efficiently', () => {
      const large = 'x'.repeat(100000) + 'FIND_ME' + 'x'.repeat(100000);
      const result = applySearchReplace(large, [
        { old_string: 'FIND_ME', new_string: 'REPLACED' },
      ]);
      expect(result).toContain('REPLACED');
      expect(result).not.toContain('FIND_ME');
      expect(result.length).toBe(200008);
    });
  });

  describe('applyUnifiedDiff', () => {
    it('should apply a single-hunk patch', () => {
      const content = 'line1\nline2\nline3\n';
      const patch =
        '--- a\n+++ b\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2_modified\n line3\n';
      const result = applyUnifiedDiff(content, patch);
      expect(result).toBe('line1\nline2_modified\nline3\n');
    });

    it('should apply a multi-hunk patch', () => {
      const content = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\n';
      const patch =
        '--- a\n+++ b\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2_modified\n line3\n@@ -5,3 +5,3 @@\n line5\n-line6\n+line6_modified\n line7\n';
      const result = applyUnifiedDiff(content, patch);
      expect(result).toBe('line1\nline2_modified\nline3\nline4\nline5\nline6_modified\nline7\n');
    });

    it('should throw DiffApplicationError when patch fails to apply', () => {
      const content = 'completely different content\n';
      const patch =
        '--- a\n+++ b\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2_modified\n line3\n';
      expect(() => applyUnifiedDiff(content, patch)).toThrow(DiffApplicationError);
      expect(() => applyUnifiedDiff(content, patch)).toThrow(
        'patch could not be applied'
      );
    });

    it('should apply additions-only patch', () => {
      const content = 'line1\nline3\n';
      const patch =
        '--- a\n+++ b\n@@ -1,2 +1,3 @@\n line1\n+line2\n line3\n';
      const result = applyUnifiedDiff(content, patch);
      expect(result).toBe('line1\nline2\nline3\n');
    });

    it('should apply deletions-only patch', () => {
      const content = 'line1\nline2\nline3\n';
      const patch =
        '--- a\n+++ b\n@@ -1,3 +1,2 @@\n line1\n-line2\n line3\n';
      const result = applyUnifiedDiff(content, patch);
      expect(result).toBe('line1\nline3\n');
    });

    it('should handle patch with surrounding context lines', () => {
      const content = 'ctx1\nctx2\ntarget\nctx3\nctx4\n';
      const patch =
        '--- a\n+++ b\n@@ -1,5 +1,5 @@\n ctx1\n ctx2\n-target\n+replaced\n ctx3\n ctx4\n';
      const result = applyUnifiedDiff(content, patch);
      expect(result).toBe('ctx1\nctx2\nreplaced\nctx3\nctx4\n');
    });
  });

  describe('resolveContent', () => {
    it('should return content directly in full-replacement mode', async () => {
      const result = await resolveContent('existing', { content: 'new content' });
      expect(result).toBe('new content');
    });

    it('should delegate to applySearchReplace for changes mode', async () => {
      const result = await resolveContent('<p>Hello</p>', {
        changes: [{ old_string: 'Hello', new_string: 'Goodbye' }],
      });
      expect(result).toBe('<p>Goodbye</p>');
    });

    it('should delegate to applyUnifiedDiff for patch mode', async () => {
      const content = 'line1\nline2\nline3\n';
      const patch =
        '--- a\n+++ b\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2_modified\n line3\n';
      const result = await resolveContent(content, { patch });
      expect(result).toBe('line1\nline2_modified\nline3\n');
    });

    it('should apply convertFn after resolving content', async () => {
      const convertFn = vi.fn(async (c: string) => `<converted>${c}</converted>`);
      const result = await resolveContent('existing', { content: 'raw' }, convertFn);
      expect(result).toBe('<converted>raw</converted>');
      expect(convertFn).toHaveBeenCalledWith('raw');
    });

    it('should not apply convertFn when not provided', async () => {
      const result = await resolveContent('existing', { content: 'raw' });
      expect(result).toBe('raw');
    });

    it('should propagate DiffApplicationError from applySearchReplace', async () => {
      await expect(
        resolveContent('<p>Hello</p>', {
          changes: [{ old_string: 'nonexistent', new_string: 'x' }],
        })
      ).rejects.toThrow(DiffApplicationError);
    });

    it('should propagate DiffApplicationError from applyUnifiedDiff', async () => {
      await expect(
        resolveContent('different content\n', {
          patch: '--- a\n+++ b\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2_mod\n line3\n',
        })
      ).rejects.toThrow(DiffApplicationError);
    });

    it('should throw if none of content/changes/patch provided', async () => {
      await expect(resolveContent('existing', {})).rejects.toThrow(DiffApplicationError);
      await expect(resolveContent('existing', {})).rejects.toThrow('No content mode specified');
    });
  });

  describe('verifySearchReplaceResults', () => {
    it('should pass when all new_strings are present in read-back', () => {
      expect(() =>
        verifySearchReplaceResults('<p>Goodbye World</p>', [
          { old_string: 'Hello', new_string: 'Goodbye' },
        ])
      ).not.toThrow();
    });

    it('should pass with multiple changes all present', () => {
      expect(() =>
        verifySearchReplaceResults('<p>Goodbye World, Goodbye Again</p>', [
          { old_string: 'Hello World', new_string: 'Goodbye World' },
          { old_string: 'Hello Again', new_string: 'Goodbye Again' },
        ])
      ).not.toThrow();
    });

    it('should throw when new_string is missing from read-back', () => {
      expect(() =>
        verifySearchReplaceResults('<p>Hello World</p>', [
          { old_string: 'Hello', new_string: 'Goodbye' },
        ])
      ).toThrow(DiffApplicationError);
      expect(() =>
        verifySearchReplaceResults('<p>Hello World</p>', [
          { old_string: 'Hello', new_string: 'Goodbye' },
        ])
      ).toThrow('read-back verification failed');
    });

    it('should skip verification for empty new_string (deletions)', () => {
      expect(() =>
        verifySearchReplaceResults('<p>World</p>', [
          { old_string: 'Hello ', new_string: '' },
        ])
      ).not.toThrow();
    });

    it('should truncate long missing strings in error message', () => {
      const longString = 'x'.repeat(300);
      try {
        verifySearchReplaceResults('unchanged', [
          { old_string: 'a', new_string: longString },
        ]);
        expect.fail('should have thrown');
      } catch (e) {
        expect((e as Error).message).toContain('x'.repeat(200) + '...');
        expect((e as Error).message).not.toContain('x'.repeat(201));
      }
    });

    it('should report only the missing changes, not all', () => {
      try {
        verifySearchReplaceResults('<p>First is here</p>', [
          { old_string: 'a', new_string: 'First is here' },
          { old_string: 'b', new_string: 'Second is missing' },
        ]);
        expect.fail('should have thrown');
      } catch (e) {
        expect((e as Error).message).toContain('Second is missing');
        expect((e as Error).message).not.toContain('First is here');
      }
    });
  });
});
