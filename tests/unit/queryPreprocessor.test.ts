import { describe, it, expect } from 'vitest';
import { preprocessSearchQuery } from '../../src/tools/queryPreprocessor.js';

describe('preprocessSearchQuery', () => {
  describe('passthrough (no transformation needed)', () => {
    it('should return simple fulltext queries unchanged', () => {
      expect(preprocessSearchQuery('meeting')).toBe('meeting');
    });

    it('should return multi-word fulltext queries unchanged (implicit AND)', () => {
      expect(preprocessSearchQuery('meeting notes')).toBe('meeting notes');
    });

    it('should return attribute filters unchanged', () => {
      expect(preprocessSearchQuery('#project')).toBe('#project');
    });

    it('should return attribute OR unchanged', () => {
      expect(preprocessSearchQuery('#book or #article')).toBe('#book or #article');
    });

    it('should return property expressions unchanged', () => {
      expect(preprocessSearchQuery('note.title *=* meeting')).toBe('note.title *=* meeting');
    });

    it('should return already-correct property OR unchanged', () => {
      expect(preprocessSearchQuery('note.content *=* foo OR note.content *=* bar'))
        .toBe('note.content *=* foo OR note.content *=* bar');
    });

    it('should return empty-ish queries unchanged', () => {
      expect(preprocessSearchQuery('')).toBe('');
      expect(preprocessSearchQuery('   ')).toBe('   ');
    });
  });

  describe('bare fulltext OR rewriting', () => {
    it('should rewrite two bare terms with OR', () => {
      expect(preprocessSearchQuery('authentication OR authorization'))
        .toBe('note.content *=* authentication OR note.content *=* authorization');
    });

    it('should handle lowercase or', () => {
      expect(preprocessSearchQuery('meeting or project'))
        .toBe('note.content *=* meeting OR note.content *=* project');
    });

    it('should handle mixed case Or', () => {
      expect(preprocessSearchQuery('bug Or issue'))
        .toBe('note.content *=* bug OR note.content *=* issue');
    });

    it('should rewrite three bare terms with OR', () => {
      expect(preprocessSearchQuery('bug OR issue OR defect'))
        .toBe('note.content *=* bug OR note.content *=* issue OR note.content *=* defect');
    });

    it('should rewrite quoted phrases with OR', () => {
      expect(preprocessSearchQuery('"meeting notes" OR "project updates"'))
        .toBe('note.content *=* "meeting notes" OR note.content *=* "project updates"');
    });

    it('should rewrite mixed single and quoted terms', () => {
      expect(preprocessSearchQuery('authentication OR "access control"'))
        .toBe('note.content *=* authentication OR note.content *=* "access control"');
    });
  });
});
