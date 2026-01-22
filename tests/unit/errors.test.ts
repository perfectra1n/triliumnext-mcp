import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { TriliumClientError } from '../../src/client/trilium.js';
import {
  formatTriliumError,
  formatZodError,
  formatUnknownError,
  formatErrorForMCP,
  type StructuredError,
} from '../../src/errors/index.js';

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

    it('should provide generic suggestion for unknown status codes', () => {
      const error = new TriliumClientError(418, 'TEAPOT', "I'm a teapot");
      const result = formatTriliumError(error);

      expect(result.status).toBe(418);
      expect(result.suggestion).toContain('unexpected error');
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
      expect(result.suggestion).toContain('unexpected error');
    });

    it('should format string errors', () => {
      const result = formatUnknownError('String error message');

      expect(result.message).toBe('String error message');
      expect(result.suggestion).toBeDefined();
    });

    it('should handle null/undefined', () => {
      const result = formatUnknownError(null);

      expect(result.message).toBe('null');
      expect(result.suggestion).toBeDefined();
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
